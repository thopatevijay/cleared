// M3-01: the holds API over held payments seeded from the recorded wallet-review capture. Workspace-scoped:
// another workspace's hold is 404 (and absent from its list); a hold on a capture this workspace doesn't
// own in `paypal_resource_owner` is not shown. The held total (here and on GET /api/payments) is per
// currency and counts only active derived holds: a PENDING payment without a hold, a released hold and
// the sample scenarios add nothing.
import { HoldDetailSchema, HoldsResponseSchema, PaymentsResponseSchema } from "@cleared/core";
import { afterAll, describe, expect, it } from "vitest";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getHold, getHolds } from "../../../src/server/handlers/holds.ts";
import { getPayments } from "../../../src/server/handlers/payments.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";
import { seedHeldPayment } from "../../../test/support/hold-seed.ts";

const created: string[] = [];

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

const list = async (cookie: string) => {
  const res = await getHolds(req("/api/holds", { method: "GET", cookie }), testDeps());
  return { status: res.status, body: HoldsResponseSchema.parse(await res.json()) };
};
const one = async (cookie: string, id: string) => {
  const res = await getHold(req(`/api/holds/${id}`, { method: "GET", cookie }), testDeps(), id);
  return { status: res.status, body: (await res.json()) as unknown };
};

describe.skipIf(!dbAvailable)("holds API (integration)", () => {
  afterAll(async () => {
    await testDb().$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
  });

  it("GET /api/holds/:id from another workspace is 404; its list doesn't show the hold", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedHeldPayment(testDb(), a.ws);
    const id = s.holdId ?? "";
    const own = await one(a.cookie, id);
    expect(own.status).toBe(200);
    const d = HoldDetailSchema.parse(own.body);
    expect(d.hold).toMatchObject({
      reason: "PENDING_REVIEW",
      type: "review",
      ruleId: "payment_review",
      state: "open",
      amount: { value: "64.00", currency: "USD" },
      openedAt: "2026-10-26T11:24:21.000Z",
      estimatedReleaseAt: "2026-10-27T11:24:21.000Z",
      estimateUpperBoundAt: "2026-10-29T11:24:21.000Z",
      dispute: null,
    });
    expect(d.payment).toMatchObject({ status: "PENDING", statusReason: "PENDING_REVIEW" });

    const foreign = await one(b.cookie, id);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ error: { details: { refusal: "NOT_FOUND" } } });
    expect((await list(b.cookie)).body.items).toEqual([]);
    expect((await one(a.cookie, "not-a-uuid")).status).toBe(404);
    expect((await one(a.cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("an unowned capture's hold is not shown; unauthenticated is 401", async () => {
    const a = await demo();
    const s = await seedHeldPayment(testDb(), a.ws, { owned: false });
    expect((await one(a.cookie, s.holdId ?? "")).status).toBe(404);
    expect((await list(a.cookie)).body.items).toEqual([]);
    const res = await getHolds(req("/api/holds", { method: "GET" }), testDeps());
    expect(res.status).toBe(401);
  });

  it("held total: per currency, active derived holds only (here and on GET /api/payments)", async () => {
    const a = await demo();
    const usd = await seedHeldPayment(testDb(), a.ws);
    await seedHeldPayment(testDb(), a.ws, { amount: "420.00" });
    await seedHeldPayment(testDb(), a.ws, { amount: "15.50", currency: "EUR" });
    // PENDING without a reason: not a hold, not held
    await seedHeldPayment(testDb(), a.ws, { amount: "999.00", reason: null });
    // a released hold leaves the total
    const gone = await seedHeldPayment(testDb(), a.ws, { amount: "700.00" });
    await testDb().$client.query("update holds set state = 'released', released_at = now() where id = $1", [
      gone.holdId,
    ]);

    const { body } = await list(a.cookie);
    expect(body.summary).toEqual({
      held: [
        { value: "15.50", currency: "EUR" },
        { value: "484.00", currency: "USD" },
      ],
      count: 3,
    });
    expect(body.items.every((i) => i.state !== "released")).toBe(true);
    // a released hold is still readable by id (the detail shows "Released")
    expect(HoldDetailSchema.parse((await one(a.cookie, gone.holdId ?? "")).body).hold.state).toBe("released");

    const res = await getPayments(req("/api/payments", { method: "GET", cookie: a.cookie }), testDeps());
    const p = PaymentsResponseSchema.parse(await res.json());
    expect(p.summary.held).toEqual(body.summary.held);
    // no row for a sample scenario: never a $700 row held, and no hold on the reason-less PENDING payment
    const held = p.items.filter((i) => i.hold !== null);
    expect(held.map((i) => i.amount.value).sort()).toEqual(["15.50", "420.00", "64.00"]);
    expect(p.items.find((i) => i.id === usd.paymentId)?.hold).toMatchObject({
      reason: "PENDING_REVIEW",
      ruleId: "payment_review",
      estimatedReleaseAt: "2026-10-27T11:24:21.000Z",
    });
    expect(p.items.find((i) => i.amount.value === "999.00")?.hold).toBeNull();
  });
});
