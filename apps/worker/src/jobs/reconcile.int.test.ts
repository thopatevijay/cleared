// M3-09 reconcile poll over recorded PayPal responses (msw):
// AC 1: a PENDING capture that PayPal released, delivered only by the poll (no webhook), releases the hold
//       through the M1-04 / M3-01 consumers with one outbox row; a second identical poll writes nothing.
// AC 2: a foreign capture (owner row in another workspace) and an unowned one get no job and no request.
// AC 3: an `unknown` provide_evidence whose reconcile chain was lost gets one final try from the poll; the
//       read-back shows our evidence → `succeeded`, with its audit rows.
// AC 5: a tick that finds another one running is skipped; the queue is a pg-boss singleton.
import { randomBytes } from "node:crypto";
import {
  createHttpClient,
  createLogger,
  createPayPalCapturesClient,
  createTokenProvider,
} from "@cleared/adapters";
import { type WorkspaceId } from "@cleared/core";
import {
  actionAuditTrail,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  getProposedAction,
  OPS_RECONCILE_QUEUE,
  platform,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import {
  approvedAction,
  ctxFor,
  disputesWithHttp,
  evidencePayload,
  LATE_RESPONSE_MS,
  NOW,
  sceneWithDispute,
  serveDispute,
  serveWrite,
  settleLateResponse,
} from "../../test/actions-support.ts";
import { FULL, STATE } from "../../test/disputes-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { holdsForEvent } from "../consumers/holds.ts";
import { CaptureSyncInputSchema, syncCapture } from "./capture-sync.ts";
import { executeAction } from "./execute-action.ts";
import { reconcileAction, ReconcileActionInputSchema } from "./reconcile-action.ts";
import { RECONCILE_LOCK_ID, runReconcile, scheduleReconcile, type ReconcileDeps } from "./reconcile.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
const created: string[] = [];
const log = createLogger({ service: "worker-test", level: "silent" });
const BASE = "https://api-m.sandbox.paypal.com";
const captureGets: string[] = [];

const freshCapture = () => `R${randomBytes(6).toString("hex").toUpperCase()}0000P`;

function capturesClient() {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: BASE,
    credentials: { clientId: "test-client", clientSecret: "test-secret" },
    cache: new Map(),
  });
  const token = loadFixture("paypal/oauth/token");
  server.use(
    http.post(
      token.request.url,
      () => new HttpResponse(responseText(token), { status: 200, headers: token.response.headers }),
    ),
  );
  return createPayPalCapturesClient({ http: h, tokens });
}

/** Serves one recorded capture GET (M0-05 chargeback) with this capture id and the workspace as custom_id. */
function serveCapture(fixture: string, captureId: string, ws: string): void {
  const body = JSON.parse(responseText(loadFixture(`${FULL}/${fixture}`))) as Record<string, unknown>;
  body["id"] = captureId;
  body["custom_id"] = ws;
  server.use(
    http.get(`${BASE}/v2/payments/captures/${captureId}`, () => HttpResponse.json(body), { once: true }),
  );
}

async function workspace(): Promise<WorkspaceId> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  created.push(ws.id);
  return ws.id as WorkspaceId;
}

const deps = (now: Date): ReconcileDeps => ({ db, publisher, now: () => now, log, alert: () => undefined });

/** The capture-sync jobs the poll enqueued for these captures (as the worker would receive them). */
async function captureJobs(captureIds: readonly string[]) {
  const r = await db.$client.query<{ data: { data: unknown } }>(
    "select data from pgboss.job where name = 'paypal.capture.sync' and data->'data'->>'captureId' = any($1)",
    [captureIds],
  );
  return r.rows.map((row) => CaptureSyncInputSchema.parse(row.data.data));
}

async function outboxFor(captureId: string) {
  const r = await db.$client.query<{ topic: string; payload: { data: Record<string, unknown> } }>(
    "select topic, payload from outbox where payload->'data'->>'captureId' = $1 order by created_at, id",
    [captureId],
  );
  return r.rows;
}

async function runSync(captureId: string, fixture: string, ws: string) {
  serveCapture(fixture, captureId, ws);
  const d = { db, publisher, captures: capturesClient(), now: () => NOW };
  const input = { captureId, source: "poll" as const };
  return withTransaction(db, (tx) => syncCapture(d, input, ctxFor(tx, input)));
}

describe.skipIf(!dbAvailable)("reconcile poll (integration)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    server.events.on("request:start", ({ request }) => {
      const u = new URL(request.url);
      if (u.pathname.startsWith("/v2/payments/captures/"))
        captureGets.push(u.pathname.split("/").at(-1) ?? "");
    });
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(async () => {
    server.close();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("AC 1: PENDING → COMPLETED by poll only releases the hold with one outbox row; a second poll writes nothing", async () => {
    const ws = await workspace();
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: ws,
    });
    // the payment and its hold as they stand: PENDING / BUYER_COMPLAINT (no webhook involved anywhere)
    await runSync(captureId, "capture-2-pending", ws);
    const opened = (await outboxFor(captureId)).at(-1);
    const hd = { db, publisher, now: () => NOW };
    expect(await withTransaction(db, (tx) => holdsForEvent(hd, opened?.payload, ctxFor(tx, {})))).toBe(
      "opened",
    );
    const before = (await outboxFor(captureId)).length;

    const tick = await runReconcile(deps(new Date()));
    expect(tick.ran).toBe(true);
    const jobs = await captureJobs([captureId]);
    expect(jobs).toEqual([{ captureId, source: "poll" }]);

    // the poll's sub-job: PayPal now says COMPLETED
    expect(await runSync(captureId, "capture-3-completed", ws)).toBe("changed");
    const after = await outboxFor(captureId);
    expect(after.length - before).toBe(1);
    const changed = after.at(-1);
    expect(changed?.topic).toBe("payment.status_changed");
    expect(changed?.payload.data).toMatchObject({
      source: "poll",
      to: { status: "COMPLETED", reason: null },
    });
    // M3-01 releases the hold from that one event
    expect(await withTransaction(db, (tx) => holdsForEvent(hd, changed?.payload, ctxFor(tx, {})))).toBe(
      "released",
    );
    const hold = await db.$client.query<{ state: string }>(
      "select h.state from holds h join payments p on p.id = h.payment_id where p.capture_id = $1",
      [captureId],
    );
    expect(hold.rows).toEqual([{ state: "released" }]);

    // a second identical poll: unchanged, nothing written (no outbox row, the payment row untouched)
    const payment = await forWorkspace(db, ws).payments.getByCaptureId(captureId);
    const outboxCount = (await outboxFor(captureId)).length;
    expect(await runSync(captureId, "capture-3-completed", ws)).toBe("unchanged");
    expect((await outboxFor(captureId)).length).toBe(outboxCount);
    expect((await forWorkspace(db, ws).payments.getByCaptureId(captureId))?.syncedAt).toEqual(
      payment?.syncedAt,
    );
  });

  it("AC 1: a second tick in the same 15-minute bucket enqueues nothing new", async () => {
    const ws = await workspace();
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: ws,
    });
    await runSync(captureId, "capture-2-pending", ws);
    const at = new Date();
    await runReconcile(deps(at));
    await runReconcile(deps(new Date(at.getTime() + 1_000)));
    expect(await captureJobs([captureId])).toHaveLength(1);
  });

  it("AC 2: a foreign or unowned capture is never enqueued or fetched", async () => {
    const [a, b] = [await workspace(), await workspace()];
    const owned = freshCapture();
    const foreign = freshCapture();
    const unowned = freshCapture();
    await platform(db).resourceOwners.claim({ resourceType: "capture", resourceId: owned, workspaceId: a });
    // the foreign capture's owner row names A, but the payment row sits in B
    await platform(db).resourceOwners.claim({ resourceType: "capture", resourceId: foreign, workspaceId: a });
    const pending = { amount: "12.00", currency: "USD", status: "PENDING", statusReason: "BUYER_COMPLAINT" };
    const row = (captureId: string) => ({ ...pending, captureId, source: "webhook" as const, syncedAt: NOW });
    await forWorkspace(db, a).payments.insert(row(owned));
    await forWorkspace(db, b).payments.insert(row(foreign));
    await forWorkspace(db, b).payments.insert(row(unowned));
    captureGets.length = 0;

    expect((await runReconcile(deps(new Date()))).ran).toBe(true);
    const jobs = await captureJobs([owned, foreign, unowned]);
    expect(jobs.map((j) => j.captureId)).toEqual([owned]);
    // run every job the poll made for this fixture set: only the owned capture is requested
    serveCapture("capture-3-completed", owned, a);
    const d = { db, publisher, captures: capturesClient(), now: () => NOW };
    for (const j of jobs) await withTransaction(db, (tx) => syncCapture(d, j, ctxFor(tx, j)));
    expect(captureGets).toEqual([owned]);
  });

  it("AC 3: a stranded unknown provide_evidence gets a final try; the read-back shows our evidence → succeeded", async () => {
    const s = await sceneWithDispute(db, created);
    const actionId = await approvedAction(
      db,
      publisher,
      s,
      "provide_evidence",
      evidencePayload(s.ids, s.draftId),
    );
    const { disputes } = disputesWithHttp(server);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveDispute(server, STATE.waiting, s.ids, s.ws);
    serveWrite(server, s.ids, "provide-evidence", "paypal/disputes/full/write-evidence.2", LATE_RESPONSE_MS);
    const ex = { db, publisher, disputes, now: () => NOW, killSwitchEnv: () => false, writeTimeoutMs: 300 };
    expect(
      await withTransaction(db, (tx) => executeAction(ex, { actionId, workspaceId: s.ws }, ctxFor(tx, {}))),
    ).toBe("unknown");
    await settleLateResponse();
    const trail = await actionAuditTrail(db, s.ws, actionId);
    expect(trail.find((r) => r.action === "action.unknown")?.detail).toMatchObject({
      before: { status: "WAITING_FOR_SELLER_RESPONSE" },
    });
    // the reconcile chain is lost (its job gone), and 46 minutes pass with no activity
    await db.$client.query(
      "delete from pgboss.job where name = 'action.reconcile' and data->'data'->>'actionId' = $1",
      [actionId],
    );
    expect((await runReconcile(deps(new Date(Date.now() + 46 * 60_000)))).ran).toBe(true);
    const r = await db.$client.query<{ data: { data: unknown } }>(
      "select data from pgboss.job where name = 'action.reconcile' and data->'data'->>'actionId' = $1",
      [actionId],
    );
    expect(r.rows).toHaveLength(1);
    const input = ReconcileActionInputSchema.parse(r.rows[0]?.data.data);
    expect(input).toMatchObject({ attempt: 5, before: { status: "WAITING_FOR_SELLER_RESPONSE" } });

    serveDispute(server, `${FULL}/state-4-under_review`, s.ids, s.ws);
    const rd = { db, publisher, disputes, now: () => NOW };
    expect(await withTransaction(db, (tx) => reconcileAction(rd, input, ctxFor(tx, input)))).toBe(
      "succeeded",
    );
    expect((await getProposedAction(db, s.ws, actionId))?.state).toBe("succeeded");
    const after = (await actionAuditTrail(db, s.ws, actionId)).map((x) => x.action);
    expect(after.slice(-2)).toEqual(["action.reconcile", "action.succeeded"]);
  });

  it("AC 5: an overlapping tick is skipped; the schedule's queue is a singleton", async () => {
    const lockHeld = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withTransaction(db, async (tx) => {
      await tx.execute(`select pg_advisory_xact_lock(${String(RECONCILE_LOCK_ID)})`);
      lockHeld.resolve();
      await release.promise;
    });
    await lockHeld.promise;
    const at = new Date();
    const count = async () =>
      (
        await db.$client.query<{ n: number }>(
          "select count(*)::int as n from ops_checks where \"check\" = 'reconcile' and run_at = $1",
          [at],
        )
      ).rows[0]?.n;
    expect(await runReconcile(deps(at))).toEqual({ ran: false });
    expect(await count()).toBe(0);
    release.resolve();
    await holder;
    // once the running tick is done, the next one runs
    expect((await runReconcile(deps(at))).ran).toBe(true);
    expect(await count()).toBe(1);

    const wired = await createQueue(db, { background: false, max: 2 });
    try {
      await scheduleReconcile({ ...deps(new Date()), boss: wired, pollingIntervalSeconds: 60 });
      expect((await wired.getQueue(OPS_RECONCILE_QUEUE))?.policy).toBe("singleton");
    } finally {
      await wired.offWork(OPS_RECONCILE_QUEUE);
      await wired.unschedule(OPS_RECONCILE_QUEUE);
      await db.$client.query("delete from pgboss.job where name = $1", [OPS_RECONCILE_QUEUE]);
      await wired.stop({ graceful: false });
    }
  });
});
