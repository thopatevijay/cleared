// M3-04: the guided Completed step on a service hold. GET /api/holds/:id carries the step's summary (the
// Activity link on the PAYPAL_ENV host); POST /api/holds/:id/completed sets the estimate to the confirmed date
// + 7 days (service_completed), walks the hold to `filed`, and writes the seller audit row and the
// `hold.completed_confirmed` outbox row with it; POST /api/holds/:id/completed/record proposes the secondary
// `record_service_completed` (capture + COMPLETED) and approving a changed payload is refused.
import { canonicalHash, HoldDetailSchema } from "@cleared/core";
import { createPublisher, createQueue, getProposedAction, type Publisher } from "@cleared/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { postApprove } from "../../../src/server/handlers/actions.ts";
import { postCompletedConfirm, postCompletedRecord } from "../../../src/server/handlers/completed.ts";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import { getHold } from "../../../src/server/handlers/holds.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { seedServiceHold } from "../../../test/support/completed-seed.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";
import { seedHeldPayment } from "../../../test/support/hold-seed.ts";

const created: string[] = [];
let pub: Promise<Publisher> | undefined;
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};
const NOW = new Date("2026-11-02T10:00:00.000Z");
const deps = () => ({ ...testDeps(), now: () => NOW });

async function demo(): Promise<{ cookie: string; ws: string }> {
  const d = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), d));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), d);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

async function detail(cookie: string, id: string) {
  const res = await getHold(req(`/api/holds/${id}`, { method: "GET", cookie }), deps(), id);
  return HoldDetailSchema.parse(await res.json());
}

async function confirm(cookie: string, id: string, body: unknown) {
  const res = await postCompletedConfirm(
    req(`/api/holds/${id}/completed`, { cookie, body }),
    deps(),
    publisher,
    id,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function record(cookie: string, id: string) {
  const res = await postCompletedRecord(
    req(`/api/holds/${id}/completed/record`, { cookie, body: {} }),
    deps(),
    id,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const seenAt = new Date("2026-10-30T08:00:00.000Z");

describe.skipIf(!dbAvailable)("guided Completed API (integration)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await testDb().$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await testDb().$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("a service hold carries the step; the Activity link host follows PAYPAL_ENV; other holds carry none", async () => {
    const a = await demo();
    const s = await seedServiceHold(testDb(), a.ws, { seenAt });
    const d = await detail(a.cookie, s.holdId);
    expect(d.hold.completed).toMatchObject({
      confirmedAt: null,
      env: "sandbox",
      record: { state: "none", actionId: null },
    });
    expect(new URL(d.hold.completed?.activityUrl ?? "").host).toBe("www.sandbox.paypal.com");
    vi.stubEnv("PAYPAL_ENV", "live");
    expect(new URL((await detail(a.cookie, s.holdId)).hold.completed?.activityUrl ?? "").host).toBe(
      "www.paypal.com",
    );
    const review = await seedHeldPayment(testDb(), a.ws);
    expect((await detail(a.cookie, review.holdId ?? "")).hold.completed ?? null).toBeNull();
  });

  it("confirming sets confirmed + 7 days (service_completed), files the hold, with audit + outbox in one go", async () => {
    const a = await demo();
    // the date is read in the workspace's zone
    await testDb().$client.query("update workspaces set timezone = 'Asia/Kolkata' where id = $1", [a.ws]);
    const s = await seedServiceHold(testDb(), a.ws, { seenAt });
    const r = await confirm(a.cookie, s.holdId, { confirmed_on: "2026-11-01" });
    expect(r.status).toBe(200);
    // 12:00 IST on 1 Nov = 06:30Z; + 7 days
    expect(r.body).toMatchObject({
      status: "confirmed",
      confirmedAt: "2026-11-01T06:30:00.000Z",
      estimatedReleaseAt: "2026-11-08T06:30:00.000Z",
      state: "filed",
    });
    const d = await detail(a.cookie, s.holdId);
    expect(d.hold).toMatchObject({
      state: "filed",
      ruleId: "service_completed",
      estimatedReleaseAt: "2026-11-08T06:30:00.000Z",
      completed: { confirmedAt: "2026-11-01T06:30:00.000Z" },
    });
    const out = await testDb().$client.query<{ payload: { data: unknown } }>(
      "select payload from outbox where topic = 'hold.completed_confirmed' and payload->'data'->>'holdId' = $1",
      [s.holdId],
    );
    expect(out.rows.map((x) => x.payload.data)).toEqual([
      {
        holdId: s.holdId,
        captureId: s.captureId,
        confirmedAt: "2026-11-01T06:30:00.000Z",
        estimatedReleaseAt: "2026-11-08T06:30:00.000Z",
      },
    ]);
    const audit = await testDb().$client.query<{ actor: string; detail: Record<string, unknown> }>(
      "select actor, detail from audit_log where workspace_id = $1 and action = 'hold.completed_confirmed'",
      [a.ws],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor: "seller",
      detail: { holdId: s.holdId, from: "open", to: "filed" },
    });
    // once only
    const again = await confirm(a.cookie, s.holdId, { confirmed_on: "2026-11-02" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { details: { refusal: "ALREADY_CONFIRMED" } } });
  });

  it("refuses future dates, dates before the hold, non-service holds and foreign holds", async () => {
    const a = await demo();
    const b = await demo();
    const s = await seedServiceHold(testDb(), a.ws, { seenAt });
    const code = async (cookie: string, id: string, on: string) =>
      ((await confirm(cookie, id, { confirmed_on: on })).body as { error: { details: { refusal: string } } })
        .error.details.refusal;
    expect(await code(a.cookie, s.holdId, "2026-11-03")).toBe("DATE_IN_FUTURE");
    expect(await code(a.cookie, s.holdId, "2026-10-29")).toBe("DATE_BEFORE_HOLD");
    expect(await code(a.cookie, s.holdId, "not-a-date")).toBe("INVALID_DATE");
    expect(await code(b.cookie, s.holdId, "2026-11-01")).toBe("NOT_FOUND");
    const review = await seedHeldPayment(testDb(), a.ws);
    expect(await code(a.cookie, review.holdId ?? "", "2026-11-01")).toBe("NOT_SERVICE_HOLD");
    // nothing moved
    expect((await detail(a.cookie, s.holdId)).hold).toMatchObject({
      state: "open",
      completed: { confirmedAt: null },
    });
  });

  it("the secondary record: a proposal on the capture, never touching the estimate; a changed payload is refused", async () => {
    const a = await demo();
    const s = await seedServiceHold(testDb(), a.ws, { seenAt });
    const before = (await detail(a.cookie, s.holdId)).hold;
    const r = await record(a.cookie, s.holdId);
    expect(r.status).toBe(201);
    const action = r.body["action"] as { id: string; kind: string; payload: unknown; payload_sha256: string };
    expect(action.kind).toBe("record_service_completed");
    expect(action.payload).toEqual({ capture_id: s.captureId, status: "COMPLETED" });
    expect(action.payload_sha256).toBe(canonicalHash({ capture_id: s.captureId, status: "COMPLETED" }));
    const after = (await detail(a.cookie, s.holdId)).hold;
    expect(after.completed?.record).toMatchObject({ state: "proposed", actionId: action.id });
    expect({ state: after.state, ruleId: after.ruleId, est: after.estimatedReleaseAt }).toEqual({
      state: before.state,
      ruleId: before.ruleId,
      est: before.estimatedReleaseAt,
    });
    // a newer proposal supersedes the waiting one (one fingerprint shown)
    const second = await record(a.cookie, s.holdId);
    expect(second.status).toBe(201);
    expect((await getProposedAction(testDb(), a.ws, action.id))?.state).toBe("rejected");
    // approving a hash that isn't the stored payload's is refused
    const id = (second.body["action"] as { id: string }).id;
    const bad = await postApprove(
      req(`/api/actions/${id}/approve`, {
        cookie: a.cookie,
        body: { payload_sha256: canonicalHash({ capture_id: "OTHER", status: "COMPLETED" }) },
      }),
      testDeps(),
      // a refused approval writes no job or event, so a publisher that is never called is enough
      () => Promise.resolve({} as Publisher),
      id,
    );
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ error: { details: { refusal: "APPROVAL_HASH_MISMATCH" } } });
  });

  it("a non-service hold refuses the record", async () => {
    const a = await demo();
    const review = await seedHeldPayment(testDb(), a.ws);
    const r = await record(a.cookie, review.holdId ?? "");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { details: { refusal: "NOT_SERVICE_HOLD" } } });
  });
});
