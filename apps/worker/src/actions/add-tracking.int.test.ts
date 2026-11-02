// `add_tracking` (M3-03 AC) over the recorded M0-04 track exchange (fixtures/paypal/tracking): an approved
// action executes once (PayPal-Request-Id = action id), writes the execution (201 + paypal-debug-id) and
// audit rows, and files the goods hold with no invented date; a payload changed after approval, an unowned
// capture and the kill switch are refused with no PayPal write; 4xx → failed; no answer → unknown →
// reconcile from the order's trackers.
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
import { NO_SNAPSHOT } from "./add-tracking.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
let publisher: Publisher;
let calls: PayPalCall[];
const created: string[] = [];

const TRACK = loadFixture("paypal/tracking/track-ind-delhivery");
const REC_ORDER = "2KC08730ML031160C";
const REC_CAPTURE = "6BC19320SY177903T";
const REC_TRACKING = "SPKA1793249841084";

interface Scene {
  readonly ws: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly holdId: string;
  readonly payload: JsonValue;
}

const id = (prefix: string) => `${prefix}${randomBytes(7).toString("hex").toUpperCase()}`.slice(0, 17);

/** The recorded body with this scene's order and capture ids (unique per test: owner claims are global). */
function recorded(s: Scene): string {
  return responseText(TRACK).replaceAll(REC_ORDER, s.orderId).replaceAll(REC_CAPTURE, s.captureId);
}

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
    orders: orders(),
    now: () => NOW,
    killSwitchEnv: () => false,
    writeTimeoutMs: 1_000,
    ...over,
  };
}

function serveTrack(s: Scene, opts: { status?: number; body?: string; waitMs?: number } = {}): void {
  server.use(
    http.post(
      `${BASE}/v2/checkout/orders/${s.orderId}/track`,
      async () => {
        if (opts.waitMs !== undefined) await delay(opts.waitMs);
        return new HttpResponse(opts.body ?? recorded(s), {
          status: opts.status ?? TRACK.response.status,
          headers: TRACK.response.headers,
        });
      },
      { once: true },
    ),
  );
}

/** A workspace owning a capture with a goods hold, and an approved IND_DELHIVERY tracking action on it. */
async function scene(owned = true): Promise<Scene & { actionId: string }> {
  const w = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
  });
  created.push(w.id);
  const orderId = id("2KC");
  const captureId = id("6BC");
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
    orderId,
    amount: "42.00",
    currency: "USD",
    status: "PENDING",
    statusReason: "OTHER",
    source: "webhook",
  });
  const hold = await repos.holds.insert({
    paymentId: payment.id,
    type: "goods",
    reason: "OTHER",
    openedAt: new Date("2026-10-29T04:57:00.000Z"),
    estimateSource: "reason_OTHER",
  });
  const payload: JsonValue = {
    order_id: orderId,
    capture_id: captureId,
    carrier: "IND_DELHIVERY",
    tracking_number: REC_TRACKING,
    notify_payer: false,
  };
  const s = { ws: w.id, orderId, captureId, holdId: hold.id, payload };
  const actionId = await approvedAction(
    db,
    publisher,
    { ws: w.id, ids: {} as never },
    "add_tracking",
    payload,
  );
  return { ...s, actionId };
}

const execute = (d: ExecuteActionDeps, s: { ws: string; actionId: string }) =>
  withTransaction(db, (tx) =>
    executeAction(d, { actionId: s.actionId, workspaceId: s.ws }, ctxFor(tx, { actionId: s.actionId })),
  );

async function stateOf(s: { ws: string; actionId: string }) {
  const row = await getProposedAction(db, s.ws, s.actionId);
  return { state: row?.state, code: row?.refusalCode ?? null };
}

const holdOf = (s: Scene) => forWorkspace(db, WorkspaceIdSchema.parse(s.ws)).holds.get(s.holdId);

describe.skipIf(!dbAvailable)("add_tracking (M3-03)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
    publisher = createPublisher(db, boss);
  });
  beforeEach(() => {
    calls = recordCalls(server);
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
    await platform(db).flags.setAgentKillSwitch(false);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("replays the recorded 201: one write (PayPal-Request-Id = action id), execution + audit rows, hold filed with no date", async () => {
    const s = await scene();
    serveTrack(s);
    expect(await execute(deps(), s)).toBe("succeeded");
    expect(await stateOf(s)).toEqual({ state: "succeeded", code: null });
    expect(writes(calls)).toEqual([
      { method: "POST", path: `/v2/checkout/orders/${s.orderId}/track`, requestId: s.actionId },
    ]);
    expect(await executionForAction(db, s.ws, s.actionId)).toMatchObject({
      idempotencyKey: s.actionId,
      paypalStatus: "201",
      paypalDebugId: "f345140fb0d0d",
      response: { orderId: s.orderId, trackerId: `${s.captureId}-${REC_TRACKING}`, trackerStatus: "SHIPPED" },
    });
    const trail = (await actionAuditTrail(db, s.ws, s.actionId)).map((a) => a.action);
    expect(trail).toEqual([
      "action.proposed",
      "action.approved",
      "action.check",
      "action.check",
      "action.check",
      "action.sent",
      "action.succeeded",
    ]);
    const hold = await holdOf(s);
    expect(hold).toMatchObject({
      state: "filed",
      estimateSource: "goods_delivered",
      estimatedReleaseAt: null,
    });
  });

  it("a payload changed after approval is refused PAYLOAD_CHANGED; nothing is sent; the hold stays", async () => {
    const s = await scene();
    await db.$client.query(
      "update proposed_actions set payload = jsonb_set(payload, '{carrier}', '\"INDIA_POST\"') where id = $1",
      [s.actionId],
    );
    expect(await execute(deps(), s)).toBe("failed");
    expect(await stateOf(s)).toEqual({ state: "failed", code: "PAYLOAD_CHANGED" });
    expect(writes(calls)).toEqual([]);
    expect((await holdOf(s))?.state).toBe("open");
  });

  it("an unowned capture is refused NOT_OWNED, and the kill switch KILL_SWITCH, with no write", async () => {
    const unowned = await scene(false);
    expect(await execute(deps(), unowned)).toBe("failed");
    expect(await stateOf(unowned)).toEqual({ state: "failed", code: "NOT_OWNED" });
    const killed = await scene();
    expect(await execute(deps({ killSwitchEnv: () => true }), killed)).toBe("failed");
    expect(await stateOf(killed)).toEqual({ state: "failed", code: "KILL_SWITCH" });
    expect(writes(calls)).toEqual([]);
  });

  it("PayPal's 4xx fails the action PAYPAL_REJECTED (no retry) and keeps the debug id", async () => {
    const s = await scene();
    const err = loadFixture("paypal/errors/400-validation");
    serveTrack(s, { status: 400, body: responseText(err) });
    expect(await execute(deps(), s)).toBe("failed");
    expect(await stateOf(s)).toEqual({ state: "failed", code: "PAYPAL_REJECTED" });
    expect(writes(calls)).toHaveLength(1);
    expect((await executionForAction(db, s.ws, s.actionId))?.paypalStatus).toBe("400");
    expect((await holdOf(s))?.state).toBe("open");
  });

  it("no answer → unknown + a reconcile job; reconcile finds the tracker on the order → succeeded, hold filed", async () => {
    const s = await scene();
    serveTrack(s, { waitMs: LATE_RESPONSE_MS });
    const d = deps();
    expect(await execute(d, s)).toBe("unknown");
    await settleLateResponse();
    expect(await stateOf(s)).toEqual({ state: "unknown", code: null });
    server.use(
      http.get(
        `${BASE}/v2/checkout/orders/${s.orderId}`,
        () => new HttpResponse(recorded(s), { status: 200, headers: TRACK.response.headers }),
        { once: true },
      ),
    );
    const input = { actionId: s.actionId, workspaceId: s.ws, attempt: 1, before: NO_SNAPSHOT };
    const r = await withTransaction(db, (tx) => reconcileAction(d, input, ctxFor(tx, input)));
    expect(r).toBe("succeeded");
    expect(await stateOf(s)).toEqual({ state: "succeeded", code: null });
    expect((await holdOf(s))?.state).toBe("filed");
    expect(writes(calls)).toHaveLength(1); // never resent
  });
});
