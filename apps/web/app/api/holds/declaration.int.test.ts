// BL-01 6570499264 (owner decision option A; ADR 0017 addendum 3): POST /api/holds/:id/declaration. The
// seller declares goods or service on a real PENDING_REVIEW hold (the recorded wallet-review capture). The
// declaration is stored with who/when and audited; it selects the guided action (goods → tracking summary +
// `add_tracking` proposals, service → the guided Completed step + `record_service_completed`), both still
// approval-bound. PayPal's type, reason, rule and estimate never change: after declaring, proposing, and
// confirming Completed the hold still reads `payment_review` with PayPal's ~24 h estimate. Changeable until
// an action is approved; locked after.
import { HoldDetailSchema, PaymentsResponseSchema, WorkspaceIdSchema } from "@cleared/core";
import { createPublisher, createQueue, forWorkspace, getProposedAction, type Publisher } from "@cleared/db";
import { afterAll, describe, expect, it } from "vitest";
import { postApprove } from "../../../src/server/handlers/actions.ts";
import { postCompletedConfirm, postCompletedRecord } from "../../../src/server/handlers/completed.ts";
import { postDeclaration } from "../../../src/server/handlers/declaration.ts";
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
let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};
const NOW = new Date("2026-10-27T09:00:00.000Z");
const deps = () => ({ ...testDeps(), now: () => NOW });
/** the recorded PENDING_REVIEW capture's update time, and PayPal's review rule: + 24 h (estimated) */
const SEEN = new Date("2026-10-26T11:24:21.000Z");
const REVIEW_ESTIMATE = "2026-10-27T11:24:21.000Z";

type Body = Record<string, unknown>;
const refusalOf = (b: Body) => (b as { error?: { details?: { refusal?: string } } }).error?.details?.refusal;

async function demo(): Promise<{ cookie: string; ws: string }> {
  const d = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), d));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), d);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

/** A real-shaped review hold: the recorded PENDING_REVIEW capture, with its PayPal order id mirrored. */
async function reviewHold(ws: string) {
  const s = await seedHeldPayment(testDb(), ws, { seenAt: SEEN });
  if (s.holdId === null) throw new Error("no hold derived");
  const orderId = `E2EO${s.captureId.slice(4)}`;
  await forWorkspace(testDb(), WorkspaceIdSchema.parse(ws)).payments.update(s.paymentId, { orderId });
  return { ...s, holdId: s.holdId, orderId };
}

async function call(res: Promise<Response>): Promise<{ status: number; body: Body }> {
  const r = await res;
  return { status: r.status, body: (await r.json()) as Body };
}

const declare = (cookie: string, id: string, body: unknown) =>
  call(postDeclaration(req(`/api/holds/${id}/declaration`, { cookie, body }), deps(), id));
const track = (cookie: string, id: string) =>
  call(
    postTrackingProposal(
      req(`/api/holds/${id}/tracking`, {
        cookie,
        body: { carrier: "IND_DELHIVERY", tracking_number: "SPKA1793249841084" },
      }),
      deps(),
      id,
    ),
  );
const recordCompleted = (cookie: string, id: string) =>
  call(postCompletedRecord(req(`/api/holds/${id}/completed/record`, { cookie, body: {} }), deps(), id));
const confirm = (cookie: string, id: string, on: string) =>
  call(
    postCompletedConfirm(
      req(`/api/holds/${id}/completed`, { cookie, body: { confirmed_on: on } }),
      deps(),
      publisher,
      id,
    ),
  );

async function detail(cookie: string, id: string) {
  const res = await getHold(req(`/api/holds/${id}`, { method: "GET", cookie }), deps(), id);
  return HoldDetailSchema.parse(await res.json());
}

/** PayPal's view of the hold, which no declaration or action may change here. */
const PAYPALS = {
  type: "review",
  reason: "PENDING_REVIEW",
  ruleId: "payment_review",
  estimatedReleaseAt: REVIEW_ESTIMATE,
};

async function audit(ws: string, action: string) {
  const r = await testDb().$client.query<{ actor: string; detail: Body }>(
    "select actor, detail from audit_log where workspace_id = $1 and action = $2 order by at, id",
    [ws, action],
  );
  return r.rows;
}

describe.skipIf(!dbAvailable)("seller's goods/service declaration (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await testDb().$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("an undeclared review hold offers the declaration and nothing else; PayPal's review estimate shows", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    const h = (await detail(a.cookie, s.holdId)).hold;
    expect(h).toMatchObject({
      ...PAYPALS,
      guidedAction: null,
      declaration: { kind: null, declaredAt: null, declarable: true, locked: false },
    });
    expect(h.tracking ?? null).toBeNull();
    expect(h.completed ?? null).toBeNull();
  });

  it("goods: stored with who/when + audited; tracking appears; PayPal's type and estimate unchanged", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    const r = await declare(a.cookie, s.holdId, { kind: "goods" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      guidedAction: "tracking",
      declaration: { kind: "goods", declaredAt: NOW.toISOString(), declarable: true, locked: false },
    });
    const h = (await detail(a.cookie, s.holdId)).hold;
    expect(h).toMatchObject({ ...PAYPALS, state: "open", guidedAction: "tracking" });
    expect(h.tracking).toMatchObject({ state: "none" });
    const row = await forWorkspace(testDb(), WorkspaceIdSchema.parse(a.ws)).holds.get(s.holdId);
    expect(row).toMatchObject({
      type: "review",
      estimateSource: "payment_review",
      sellerDeclaredKind: "goods",
      sellerDeclaredAt: NOW,
    });
    expect(row?.sellerDeclaredBy).toMatch(/.+/);
    expect(await audit(a.ws, "hold.declared")).toEqual([
      {
        actor: "seller",
        detail: expect.objectContaining({
          holdId: s.holdId,
          paymentId: s.paymentId,
          kind: "goods",
          from: null,
          to: "goods",
          reason: "PENDING_REVIEW",
          by: row?.sellerDeclaredBy,
        }) as unknown,
      },
    ]);
    // the dashboard row carries it too
    const pay = await getPayments(req("/api/payments", { method: "GET", cookie: a.cookie }), deps());
    const item = PaymentsResponseSchema.parse(await pay.json()).items.find((i) => i.id === s.paymentId);
    expect(item?.hold).toMatchObject({
      ...PAYPALS,
      guidedAction: "tracking",
      declaration: { kind: "goods" },
      tracking: { state: "none" },
    });
    // the same answer again changes nothing and writes no second audit row
    expect((await declare(a.cookie, s.holdId, { kind: "goods" })).status).toBe(200);
    expect(await audit(a.ws, "hold.declared")).toHaveLength(1);
  });

  it("goods → File tracking proposes the approval-bound add_tracking bound to the order + capture", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    expect(refusalOf((await track(a.cookie, s.holdId)).body)).toBe("NOT_GOODS_HOLD");
    await declare(a.cookie, s.holdId, { kind: "goods" });
    const p = await track(a.cookie, s.holdId);
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({
      action: {
        kind: "add_tracking",
        state: "proposed",
        payload: {
          order_id: s.orderId,
          capture_id: s.captureId,
          carrier: "IND_DELHIVERY",
          tracking_number: "SPKA1793249841084",
          notify_payer: false,
        },
      },
    });
    expect((await detail(a.cookie, s.holdId)).hold).toMatchObject({
      ...PAYPALS,
      tracking: { state: "proposed" },
    });
  });

  it("changing goods → service sets aside the waiting tracking proposal; service offers the Completed step", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    await declare(a.cookie, s.holdId, { kind: "goods" });
    const proposed = (await track(a.cookie, s.holdId)).body as { action: { id: string } };
    const r = await declare(a.cookie, s.holdId, { kind: "service" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ guidedAction: "completed", declaration: { kind: "service" } });
    expect((await getProposedAction(testDb(), a.ws, proposed.action.id))?.state).toBe("rejected");
    const rejected = await audit(a.ws, "action.rejected");
    expect(rejected.map((x) => x.detail)).toEqual([
      expect.objectContaining({ actionId: proposed.action.id, reason: "declaration_changed" }),
    ]);
    const h = (await detail(a.cookie, s.holdId)).hold;
    expect(h).toMatchObject({ ...PAYPALS, guidedAction: "completed", completed: { confirmedAt: null } });
    expect(h.tracking ?? null).toBeNull();
    expect(refusalOf((await track(a.cookie, s.holdId)).body)).toBe("NOT_GOODS_HOLD");
    const rec = await recordCompleted(a.cookie, s.holdId);
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({
      action: { kind: "record_service_completed", payload: { capture_id: s.captureId, status: "COMPLETED" } },
    });
    expect((await declare(a.cookie, s.holdId, { kind: "goods" })).status).toBe(200);
    const recId = (rec.body as { action: { id: string } }).action.id;
    expect((await getProposedAction(testDb(), a.ws, recId))?.state).toBe("rejected");
  });

  it("locked once the seller approves the action; PayPal's estimate still unchanged", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    await declare(a.cookie, s.holdId, { kind: "goods" });
    const p = (await track(a.cookie, s.holdId)).body as { action: { id: string; payload_sha256: string } };
    const approve = await postApprove(
      req(`/api/actions/${p.action.id}/approve`, {
        cookie: a.cookie,
        body: { payload_sha256: p.action.payload_sha256 },
      }),
      deps(),
      publisher,
      p.action.id,
    );
    expect(approve.status).toBe(200);
    const locked = await declare(a.cookie, s.holdId, { kind: "service" });
    expect(locked.status).toBe(409);
    expect(refusalOf(locked.body)).toBe("DECLARATION_LOCKED");
    expect((await declare(a.cookie, s.holdId, { kind: "goods" })).status).toBe(200);
    expect((await detail(a.cookie, s.holdId)).hold).toMatchObject({
      ...PAYPALS,
      declaration: { kind: "goods", locked: true },
      tracking: { state: "filing" },
    });
  });

  it("service → confirming Completed files the hold but keeps PayPal's review estimate (no 7-day estimate, no event)", async () => {
    const a = await demo();
    const s = await reviewHold(a.ws);
    expect(refusalOf((await confirm(a.cookie, s.holdId, "2026-10-27")).body)).toBe("NOT_SERVICE_HOLD");
    await declare(a.cookie, s.holdId, { kind: "service" });
    const c = await confirm(a.cookie, s.holdId, "2026-10-27");
    expect(c.status).toBe(200);
    expect(c.body).toEqual({
      status: "confirmed",
      confirmedAt: NOW.toISOString(),
      estimatedReleaseAt: REVIEW_ESTIMATE,
      estimateChanged: false,
      state: "filed",
    });
    const h = (await detail(a.cookie, s.holdId)).hold;
    expect(h).toMatchObject({
      ...PAYPALS,
      state: "filed",
      estimateUpperBoundAt: "2026-10-29T11:24:21.000Z", // the review rule's 3 business days, still
      completed: { confirmedAt: NOW.toISOString() },
      declaration: { kind: "service", locked: true },
    });
    const out = await testDb().$client.query(
      "select 1 from outbox where topic = 'hold.completed_confirmed' and payload->'data'->>'holdId' = $1",
      [s.holdId],
    );
    expect(out.rowCount).toBe(0);
    expect(await audit(a.ws, "hold.completed_confirmed")).toEqual([
      {
        actor: "seller",
        detail: expect.objectContaining({
          holdId: s.holdId,
          estimatedReleaseAt: REVIEW_ESTIMATE,
          estimateChanged: false,
        }) as unknown,
      },
    ]);
    expect(refusalOf((await declare(a.cookie, s.holdId, { kind: "goods" })).body)).toBe("DECLARATION_LOCKED");
  });

  it("refuses foreign holds, PayPal-typed goods holds, released holds and bad bodies", async () => {
    const a = await demo();
    const b = await demo();
    const s = await reviewHold(a.ws);
    expect((await declare(b.cookie, s.holdId, { kind: "goods" })).status).toBe(404);
    expect((await declare(a.cookie, "not-a-uuid", { kind: "goods" })).status).toBe(404);
    expect((await declare(a.cookie, s.holdId, { kind: "digital" })).status).toBe(400);
    expect((await declare(a.cookie, s.holdId, { kind: "goods", by: "x" })).status).toBe(400);
    const goods = await seedGoodsHold(testDb(), a.ws);
    const typed = await declare(a.cookie, goods.holdId, { kind: "service" });
    expect(typed.status).toBe(409);
    expect(refusalOf(typed.body)).toBe("NOT_DECLARABLE");
    expect((await detail(a.cookie, goods.holdId)).hold).toMatchObject({
      type: "goods",
      guidedAction: "tracking",
      declaration: { kind: null, declarable: false },
    });
    const released = await reviewHold(a.ws);
    await forWorkspace(testDb(), WorkspaceIdSchema.parse(a.ws)).holds.update(released.holdId, {
      state: "released",
      releasedAt: NOW,
    });
    expect(refusalOf((await declare(a.cookie, released.holdId, { kind: "goods" })).body)).toBe(
      "NOT_DECLARABLE",
    );
    // nothing was stored on any of them
    expect(await audit(a.ws, "hold.declared")).toEqual([]);
  });
});
