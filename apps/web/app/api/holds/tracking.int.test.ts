// M3-03: the goods hold's tracking summary on GET /api/holds/:id and GET /api/payments, and the seller's
// `add_tracking` proposal (POST /api/holds/:id/tracking): bound to the hold's order + capture, only on a
// goods hold, PayPal-listed carriers only, one waiting fingerprint at a time; approving a changed payload
// is refused APPROVAL_HASH_MISMATCH.
import { canonicalHash, HoldDetailSchema, PaymentsResponseSchema } from "@cleared/core";
import { getProposedAction, type Publisher } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { postApprove } from "../../../src/server/handlers/actions.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getHold } from "../../../src/server/handlers/holds.ts";
import { getPayments } from "../../../src/server/handlers/payments.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { postTrackingProposal } from "../../../src/server/handlers/tracking.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";
import { seedHeldPayment } from "../../../test/support/hold-seed.ts";
import { seedGoodsHold } from "../../../test/support/tracking-seed.ts";

const created: string[] = [];

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

async function propose(cookie: string, holdId: string, body: unknown) {
  const res = await postTrackingProposal(
    req(`/api/holds/${holdId}/tracking`, { cookie, body }),
    testDeps(),
    holdId,
  );
  return { status: res.status, body: (await res.json()) as unknown };
}

async function detail(cookie: string, id: string) {
  const res = await getHold(req(`/api/holds/${id}`, { method: "GET", cookie }), testDeps(), id);
  return HoldDetailSchema.parse(await res.json());
}

describe.skipIf(!dbAvailable)("tracking API (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
  });

  it("a goods hold carries route advice from its shipment evidence (here and on GET /api/payments)", async () => {
    const a = await demo();
    const s = await seedGoodsHold(testDb(), a.ws, {
      shipment: { carrier: "India Post", tracking_number: "EE123456789IN" },
    });
    const t = (await detail(a.cookie, s.holdId)).hold.tracking;
    expect(t).toMatchObject({
      state: "none",
      chosen: { code: "INDIA_POST", tier: "accepted" },
      flagged: true,
      prefill: { carrier: "INDIA_POST", tracking_number: "EE123456789IN" },
    });
    expect(t?.alternatives.slice(0, 4).map((x) => x.code)).toEqual([
      "IND_DELHIVERY",
      "DTDC_IN",
      "EKART",
      "BLUEDART",
    ]);
    const pay = await getPayments(req("/api/payments", { method: "GET", cookie: a.cookie }), testDeps());
    const row = PaymentsResponseSchema.parse(await pay.json()).items.find((i) => i.id === s.paymentId);
    expect(row?.hold?.tracking?.flagged).toBe(true);
  });

  it("a payment-review hold has no tracking summary and refuses a proposal", async () => {
    const a = await demo();
    const r = await seedHeldPayment(testDb(), a.ws);
    expect((await detail(a.cookie, r.holdId ?? "")).hold.tracking ?? null).toBeNull();
    const res = await propose(a.cookie, r.holdId ?? "", { carrier: "IND_DELHIVERY", tracking_number: "D1" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { details: { refusal: "NOT_GOODS_HOLD" } } });
  });

  it("proposes add_tracking bound to the order + capture; a newer one supersedes; a changed payload can't be approved", async () => {
    const a = await demo();
    const s = await seedGoodsHold(testDb(), a.ws);
    const first = await propose(a.cookie, s.holdId, {
      carrier: "INDIA_POST",
      tracking_number: "EE 123 456 789 IN",
    });
    expect(first.status).toBe(201);
    const firstAction = (first.body as { action: { id: string; payload: unknown; payload_sha256: string } })
      .action;
    expect(firstAction.payload).toEqual({
      order_id: s.orderId,
      capture_id: s.captureId,
      carrier: "INDIA_POST",
      tracking_number: "EE123456789IN",
      notify_payer: false,
    });
    expect(firstAction.payload_sha256).toBe(canonicalHash(firstAction.payload as never));

    const second = await propose(a.cookie, s.holdId, { carrier: "IND_DELHIVERY", tracking_number: "SPK1" });
    const secondAction = (second.body as { action: { id: string; payload_sha256: string } }).action;
    expect((await getProposedAction(testDb(), a.ws, firstAction.id))?.state).toBe("rejected");
    expect((await detail(a.cookie, s.holdId)).hold.tracking).toMatchObject({
      state: "proposed",
      actionId: secondAction.id,
      chosen: { code: "IND_DELHIVERY", tier: "approved" },
      flagged: false,
    });

    // the seller saw the first fingerprint; approving the second action with it is refused
    const mismatch = await postApprove(
      req(`/api/actions/${secondAction.id}/approve`, {
        cookie: a.cookie,
        body: { payload_sha256: firstAction.payload_sha256 },
      }),
      testDeps(),
      // a refused approval writes no job or event, so a publisher that is never called is enough
      () => Promise.resolve({} as Publisher),
      secondAction.id,
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { details: { refusal: "APPROVAL_HASH_MISMATCH" } },
    });
  });

  it("refuses unknown carriers, bad tracking numbers, OTHER without a name, and foreign holds", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedGoodsHold(testDb(), a.ws);
    const bad = async (body: unknown, code: string, cookie = a.cookie) => {
      const r = await propose(cookie, s.holdId, body);
      expect(r.body).toMatchObject({ error: { details: { refusal: code } } });
    };
    await bad({ carrier: "NOT_A_CARRIER", tracking_number: "X1" }, "UNKNOWN_CARRIER");
    await bad({ carrier: "OTHER", tracking_number: "X1" }, "UNKNOWN_CARRIER");
    await bad({ carrier: "IND_DELHIVERY", tracking_number: "bad/char" }, "INVALID_TRACKING");
    await bad({ carrier: "IND_DELHIVERY", tracking_number: "X1" }, "NOT_FOUND", b.cookie);
    const ok = await propose(a.cookie, s.holdId, {
      carrier: "OTHER",
      carrier_name_other: "Raju courier",
      tracking_number: "R-1",
    });
    expect(ok.status).toBe(201);
  });
});
