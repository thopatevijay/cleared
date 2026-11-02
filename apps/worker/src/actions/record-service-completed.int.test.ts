// `record_service_completed` (M3-04 AC 1 worker side + AC 2) over the recorded M0-04 trackers-batch exchange
// (fixtures/paypal/tracking): an approved action sends one trackers-batch write (the capture, COMPLETED,
// no carrier, no tracking number: the recorded request), stores the execution (200 + paypal-debug-id) and the read-back status
// COMPLETED, and leaves the hold exactly as it was (no state move, no estimate); a payload changed after
// approval is refused with no write; a 200 with errors → failed; no answer → unknown → reconcile by reading
// the tracker back (never resent).
import { randomBytes } from "node:crypto";
import { createHttpClient, createPayPalOrdersClient, createTokenProvider } from "@cleared/adapters";
import { WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import {
  actionAuditTrail,
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  executionForAction,
  forWorkspace,
  getProposedAction,
  platform,
  withTransaction,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { delay, http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import {
  approvedAction,
  BASE,
  ctxFor,
  LATE_RESPONSE_MS,
  NOW,
  recordCalls,
  settleLateResponse,
  writes,
  type PayPalCall,
} from "../../test/actions-support.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { executeAction, type ExecuteActionDeps } from "../jobs/execute-action.ts";
import { reconcileAction } from "../jobs/reconcile-action.ts";
import { NO_SNAPSHOT } from "./hold-action.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
let calls: PayPalCall[];
let bodies: unknown[];
const created: string[] = [];

const BATCH = loadFixture("paypal/tracking/trackers-batch-completed");
const READ = loadFixture("paypal/tracking/get-legacy-tracker");
const REC_CAPTURE = "7AS90958XD7569923";
const ESTIMATE = new Date("2026-10-30T04:57:00.000Z");

interface Scene {
  readonly ws: string;
  readonly captureId: string;
  readonly holdId: string;
  readonly actionId: string;
}

const id = () => `7AS${randomBytes(7).toString("hex").toUpperCase()}`.slice(0, 17);

/** A recorded body with this scene's capture id (unique per test: owner claims are global). */
const recorded = (f: typeof BATCH, s: Scene) => responseText(f).replaceAll(REC_CAPTURE, s.captureId);

function orders() {
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
  return createPayPalOrdersClient({ http: h, tokens });
}

function deps(over: Partial<ExecuteActionDeps> = {}): ExecuteActionDeps {
  const missing = () => Promise.reject(new Error("no dispute call expected"));
  return {
    db,
    publisher,
    disputes: {
      getDispute: missing,
      provideEvidence: missing,
      provideSupportingInfo: missing,
      acceptClaim: missing,
    },
    completed: orders(),
    now: () => NOW,
    killSwitchEnv: () => false,
    writeTimeoutMs: 1_000,
    ...over,
  };
}

function serveBatch(s: Scene, opts: { body?: string; waitMs?: number } = {}): void {
  server.use(
    http.post(
      BATCH.request.url,
      async ({ request }) => {
        bodies.push(await request.json());
        if (opts.waitMs !== undefined) await delay(opts.waitMs);
        return new HttpResponse(opts.body ?? recorded(BATCH, s), {
          status: BATCH.response.status,
          headers: BATCH.response.headers,
        });
      },
      { once: true },
    ),
  );
}

function serveReadBack(s: Scene): void {
  server.use(
    http.get(
      `${BASE}/v1/shipping/trackers/${s.captureId}-NOTRACKER`,
      () => new HttpResponse(recorded(READ, s), { status: 200, headers: READ.response.headers }),
      { once: true },
    ),
  );
}

/** A workspace owning a capture with a service hold (synthetic: the sandbox can't derive one), and an approved record. */
async function scene(owned = true): Promise<Scene & { payload: JsonValue }> {
  const w = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
  });
  created.push(w.id);
  const captureId = id();
  if (owned) {
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: w.id,
    });
  }
  const repos = forWorkspace(db, WorkspaceIdSchema.parse(w.id));
  const payment = await repos.payments.insert({
    captureId,
    amount: "120.00",
    currency: "USD",
    status: "PENDING",
    statusReason: "OTHER",
    source: "webhook",
  });
  const hold = await repos.holds.insert({
    paymentId: payment.id,
    type: "service",
    reason: "OTHER",
    openedAt: new Date("2026-10-29T04:57:00.000Z"),
    estimateSource: "reason_OTHER",
    estimatedReleaseAt: ESTIMATE,
  });
  const payload: JsonValue = { capture_id: captureId, status: "COMPLETED" };
  const actionId = await approvedAction(
    db,
    publisher,
    { ws: w.id, ids: {} as never },
    "record_service_completed",
    payload,
  );
  return { ws: w.id, captureId, holdId: hold.id, actionId, payload };
}

const execute = (d: ExecuteActionDeps, s: Scene) =>
  withTransaction(db, (tx) =>
    executeAction(d, { actionId: s.actionId, workspaceId: s.ws }, ctxFor(tx, { actionId: s.actionId })),
  );

async function stateOf(s: Scene) {
  const row = await getProposedAction(db, s.ws, s.actionId);
  return { state: row?.state, code: row?.refusalCode ?? null };
}

/** The hold as the secondary action must leave it: open, its own rule, its own estimate. */
async function expectHoldUntouched(s: Scene) {
  expect(await forWorkspace(db, WorkspaceIdSchema.parse(s.ws)).holds.get(s.holdId)).toMatchObject({
    state: "open",
    estimateSource: "reason_OTHER",
    estimatedReleaseAt: ESTIMATE,
    completedConfirmedAt: null,
  });
}

describe.skipIf(!dbAvailable)("record_service_completed (M3-04)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  beforeEach(() => {
    calls = recordCalls(server);
    bodies = [];
  });
  afterEach(() => {
    server.events.removeAllListeners();
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

  it("replays the recorded 200: one write, execution + read-back COMPLETED stored, the estimate unchanged", async () => {
    const s = await scene();
    serveBatch(s);
    serveReadBack(s);
    expect(await execute(deps(), s)).toBe("succeeded");
    expect(await stateOf(s)).toEqual({ state: "succeeded", code: null });
    expect(writes(calls).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/shipping/trackers-batch"]);
    // exactly the recorded M0-04 request body, with this scene's capture
    expect(bodies).toEqual([
      JSON.parse(JSON.stringify(BATCH.request.body).replaceAll(REC_CAPTURE, s.captureId)),
    ]);
    expect(await executionForAction(db, s.ws, s.actionId)).toMatchObject({
      paypalStatus: "200",
      paypalDebugId: "f529566754294",
      response: { captureId: s.captureId, trackerId: `${s.captureId}-NOTRACKER`, trackerStatus: "COMPLETED" },
    });
    const trail = (await actionAuditTrail(db, s.ws, s.actionId)).map((a) => a.action);
    expect(trail).toEqual([
      "action.proposed",
      "action.approved",
      "action.check",
      "action.check",
      "action.check",
      "action.sent",
      "action.read_back",
      "action.succeeded",
    ]);
    await expectHoldUntouched(s);
  });

  it("a payload changed after approval is refused PAYLOAD_CHANGED with no write", async () => {
    const s = await scene();
    await db.$client.query(
      "update proposed_actions set payload = jsonb_set(payload, '{capture_id}', '\"7ASOTHERCAPTURE00\"') where id = $1",
      [s.actionId],
    );
    expect(await execute(deps(), s)).toBe("failed");
    expect(await stateOf(s)).toEqual({ state: "failed", code: "PAYLOAD_CHANGED" });
    expect(writes(calls)).toEqual([]);
    await expectHoldUntouched(s);
  });

  it("an unowned capture → NOT_OWNED; the kill switch → KILL_SWITCH; no write", async () => {
    const unowned = await scene(false);
    expect(await execute(deps(), unowned)).toBe("failed");
    expect(await stateOf(unowned)).toEqual({ state: "failed", code: "NOT_OWNED" });
    const killed = await scene();
    expect(await execute(deps({ killSwitchEnv: () => true }), killed)).toBe("failed");
    expect(await stateOf(killed)).toEqual({ state: "failed", code: "KILL_SWITCH" });
    expect(writes(calls)).toEqual([]);
  });

  it("a 200 with per-tracker errors fails PAYPAL_REJECTED and keeps the debug id", async () => {
    const s = await scene();
    const body = JSON.stringify({
      tracker_identifiers: [],
      errors: [{ name: "INVALID_REQUEST", message: "x" }],
    });
    serveBatch(s, { body });
    expect(await execute(deps(), s)).toBe("failed");
    expect(await stateOf(s)).toEqual({ state: "failed", code: "PAYPAL_REJECTED" });
    expect((await executionForAction(db, s.ws, s.actionId))?.paypalDebugId).toBe("f529566754294");
    await expectHoldUntouched(s);
  });

  it("no answer → unknown + reconcile reads the tracker back COMPLETED → succeeded, never resent", async () => {
    const s = await scene();
    serveBatch(s, { waitMs: LATE_RESPONSE_MS });
    const d = deps();
    expect(await execute(d, s)).toBe("unknown");
    await settleLateResponse();
    serveReadBack(s);
    const input = { actionId: s.actionId, workspaceId: s.ws, attempt: 1, before: NO_SNAPSHOT };
    const r = await withTransaction(db, (tx) => reconcileAction(d, input, ctxFor(tx, input)));
    expect(r).toBe("succeeded");
    expect(await stateOf(s)).toEqual({ state: "succeeded", code: null });
    expect(writes(calls)).toHaveLength(1);
    await expectHoldUntouched(s);
  });
});
