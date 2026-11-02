// M3-10 review-hold pool (ADR 0019), on the compose Postgres with msw serving PayPal:
// - AC 1: pool:create writes the order owner rows; an assignment moves exactly one held row (owner rows,
//   payment, hold, explanation) with a `pool.assigned` audit entry; two parallel assignments never share a capture
// - AC 2: rows that aren't pool-owned, are released, or are 20 h old are never assigned
// - AC 3: fixture replay of the live pool's PENDING_REVIEW capture (M3-10, 2026-11-02): pool:capture marks the row held, enqueues the
//   capture sync, and the M3-01 holds consumer opens a hold with rule `payment_review`
// - AC 5: the CLI's output carries no token or credential
// - a moved capture keeps the pool's custom_id and still syncs into the judge workspace (not quarantined)
// Each test runs at its own far-future `now`, so its 20 h assignment window only sees the rows it made.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  createHttpClient,
  createLogger,
  createPayPalCapturesClient,
  createPayPalOrdersClient,
  createTokenProvider,
} from "@cleared/adapters";
import type { WorkspaceId } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
  type Tx,
} from "@cleared/db";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { holdsForEvent } from "../consumers/holds.ts";
import { syncCapture } from "../jobs/capture-sync.ts";
import { runPool } from "./pool.ts";
import type { PoolDeps } from "./pool-ops.ts";

const BASE = "https://api-m.sandbox.paypal.com";
const server = setupServer();
const db = createDb(url);
let boss: Queue;
const workspaces: string[] = [];
const SECRET = `test-secret-${randomUUID()}`;
const CREDENTIAL = /access_token|client_secret|Bearer |test-secret|A21AA/i;

const fresh = (p: string) => `${p}${randomBytes(6).toString("hex").toUpperCase()}0000P`;
/** A far-future `now` per test: the 20 h window can't reach another test's (or a live pool's) rows. */
const isolatedNow = () => new Date(Date.UTC(2040, 0, 1) + randomInt(0, 2_000_000) * 3_600_000);

function ctx(tx: Tx, data: unknown, now: Date) {
  const log = createLogger({ service: "worker-test", level: "silent" });
  const job = { id: randomUUID(), retryCount: 0, createdOn: now } as JobWithMetadata<unknown>;
  return { tx, log, job, envelope: { messageId: randomUUID(), correlationId: randomUUID(), data } };
}

function paypalHttp() {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: BASE,
    credentials: { clientId: "test-client", clientSecret: SECRET },
    cache: new Map(),
  });
  const token = loadFixture("paypal/oauth/token");
  server.use(
    http.post(
      token.request.url,
      () => new HttpResponse(responseText(token), { status: 200, headers: token.response.headers }),
    ),
  );
  return { http: h, tokens };
}

function poolDeps(now: Date): PoolDeps {
  return {
    db,
    orders: createPayPalOrdersClient(paypalHttp()),
    publisher: createPublisher(db, boss),
    now: () => now,
  };
}

async function run(argv: string[], now: Date): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
  const deps = {
    db,
    paypal: () => Promise.resolve(poolDeps(now)),
    now: () => now,
    returnUrl: "https://example.com/",
  };
  const code = await runPool(argv, deps, io);
  return { code, out: lines.join("\n") };
}

async function workspace(kind: "seller" | "demo" = "demo", tx?: Tx): Promise<WorkspaceId> {
  const ws = await platform(db).workspaces.create(
    { kind, locale: "en", timezone: "UTC", baseCurrency: "USD", llmBudgetUsd: "0" },
    tx,
  );
  workspaces.push(ws.id);
  return ws.id as WorkspaceId;
}

interface Seed {
  readonly pool: string;
  readonly poolId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly paymentId: string;
  readonly holdId: string;
}

/** A held pool row as pool:capture + the M3-01 path leave it: owner rows, payment, hold, explanation. */
async function seedHeld(
  now: Date,
  o: { pool?: string; ageHours?: number; purpose?: "judge" | "video"; owner?: string; status?: string } = {},
): Promise<Seed> {
  const pool = o.pool ?? (await workspace("seller"));
  const orderId = fresh("O");
  const captureId = fresh("C");
  const capturedAt = new Date(now.getTime() - (o.ageHours ?? 1) * 3_600_000);
  const p = platform(db);
  await p.resourceOwners.claim({ resourceType: "order", resourceId: orderId, workspaceId: pool });
  await p.resourceOwners.claim({
    resourceType: "capture",
    resourceId: captureId,
    workspaceId: o.owner ?? pool,
  });
  const row = await p.reviewHoldPool.insert({
    orderId,
    poolWorkspaceId: pool,
    purpose: o.purpose ?? "judge",
    amount: "64.00",
    currency: "USD",
    approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
  });
  await p.reviewHoldPool.markCaptured(row.id, {
    captureId,
    captureStatus: "PENDING",
    captureReason: "PENDING_REVIEW",
    capturedAt,
    state: "held",
  });
  const payment = await forWorkspace(db, pool as WorkspaceId).payments.insert({
    captureId,
    orderId,
    amount: "64.00",
    currency: "USD",
    status: o.status ?? "PENDING",
    statusReason: "PENDING_REVIEW",
    source: "poll",
    paypalUpdatedAt: capturedAt,
  });
  const hold = await db.$client.query<{ id: string }>(
    `insert into holds (workspace_id, payment_id, type, reason, opened_at, estimated_release_at, estimate_source)
     values ($1, $2, 'review', 'PENDING_REVIEW', $3, $3::timestamptz + interval '24 hours', 'payment_review') returning id`,
    [pool, payment.id, capturedAt],
  );
  const holdId = hold.rows[0]?.id ?? "";
  await db.$client.query(
    "insert into explanations (workspace_id, hold_id, locale, text, source_ref) values ($1, $2, 'en', 'standard text', 'payment_review')",
    [pool, holdId],
  );
  return { pool, poolId: row.id, orderId, captureId, paymentId: payment.id, holdId };
}

const assign = (workspaceId: string, now: Date, purpose: "judge" | "video" = "judge") =>
  withTransaction(db, (tx) => platform(db).reviewHoldPool.assign({ workspaceId, purpose, now }, tx));

async function workspaceOf(
  table: "payments" | "holds" | "explanations",
  id: string,
): Promise<string | undefined> {
  const r = await db.$client.query<{ workspace_id: string }>(
    `select workspace_id from ${table} where id = $1`,
    [id],
  );
  return r.rows[0]?.workspace_id;
}

async function owners(ids: readonly string[]) {
  const r = await db.$client.query<{
    resource_type: string;
    workspace_id: string;
    transferred_from: string | null;
  }>(
    "select resource_type, workspace_id, transferred_from from paypal_resource_owner where resource_id = any($1) order by resource_type::text",
    [ids],
  );
  return r.rows;
}

describe.skipIf(!dbAvailable)("review-hold pool (integration)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  beforeEach(() => {
    // pool:capture reads every awaiting and held pool row in this database (other tests', earlier runs'):
    // they stay waiting / held. A test's own handlers, added later, take precedence.
    server.use(
      http.get(`${BASE}/v2/checkout/orders/:id`, ({ params }) =>
        HttpResponse.json({ id: String(params["id"]), status: "PAYER_ACTION_REQUIRED" }),
      ),
      http.get(`${BASE}/v2/payments/captures/:id`, ({ params }) =>
        HttpResponse.json({
          id: String(params["id"]),
          status: "PENDING",
          status_details: { reason: "PENDING_REVIEW" },
          amount: { currency_code: "USD", value: "64.00" },
        }),
      ),
    );
  });
  afterAll(async () => {
    server.close();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [workspaces]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [workspaces],
    );
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("AC 1/5: pool:create writes a wallet order, its owner row and an awaiting_buyer row; prints only the approval URL", async () => {
    const now = isolatedNow();
    const bodies: unknown[] = [];
    const orderIds: string[] = [];
    server.use(
      http.post(`${BASE}/v2/checkout/orders`, async ({ request }) => {
        bodies.push(await request.json());
        const id = fresh("W");
        orderIds.push(id);
        return HttpResponse.json(
          {
            id,
            status: "PAYER_ACTION_REQUIRED",
            links: [
              { href: `${BASE}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
              {
                href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
                rel: "payer-action",
                method: "GET",
              },
            ],
          },
          { status: 200 },
        );
      }),
    );
    const { code, out } = await run(["create", "--count", "2", "--purpose", "judge"], now);
    expect(code).toBe(0);
    expect(orderIds).toHaveLength(2);
    const pool = await platform(db).reviewHoldPool.poolWorkspaceId();
    if (pool === null) throw new Error("no pool workspace");
    workspaces.push(pool);
    for (const [i, id] of orderIds.entries()) {
      expect(out).toContain(`https://www.sandbox.paypal.com/checkoutnow?token=${id}`);
      expect(await owners([id])).toEqual([
        { resource_type: "order", workspace_id: pool, transferred_from: null },
      ]);
      expect(bodies[i]).toMatchObject({
        intent: "CAPTURE",
        purchase_units: [{ custom_id: pool, amount: { currency_code: "USD" } }],
        payment_source: { paypal: { experience_context: { user_action: "PAY_NOW" } } },
      });
    }
    const rows = (await platform(db).reviewHoldPool.list()).filter((r) => orderIds.includes(r.orderId));
    expect(rows.map((r) => [r.state, r.purpose, r.poolWorkspaceId])).toEqual([
      ["awaiting_buyer", "judge", pool],
      ["awaiting_buyer", "judge", pool],
    ]);
    expect(out).not.toMatch(CREDENTIAL);
    // the pool workspace has no AI budget: its hold explanations are the standard text (no spend)
    expect((await platform(db).workspaces.get(pool))?.llmBudgetUsd).toBe("0");
    await expect(run(["create", "--count", "9", "--purpose", "judge"], now)).rejects.toThrow(
      "--count must be 1..5",
    );
  });

  it("AC 3: fixture replay: pool:capture marks the row held and the hold appears with rule payment_review", async () => {
    const now = isolatedNow();
    const pool = (await platform(db).reviewHoldPool.poolWorkspaceId()) ?? (await workspace("seller"));
    const orderId = fresh("R");
    const captureId = fresh("C");
    await platform(db).resourceOwners.claim({
      resourceType: "order",
      resourceId: orderId,
      workspaceId: pool,
    });
    const row = await platform(db).reviewHoldPool.insert({
      orderId,
      poolWorkspaceId: pool,
      purpose: "video",
      amount: "64.00",
      currency: "USD",
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    });
    // M3-10's live pool, recorded 2026-11-02 (fixtures/paypal/captures/PROVENANCE.md): the video row's capture
    // (84S22913092039910) and its order, status and reason verbatim; the ids, custom_id and times are this
    // test's, so a re-run on the same database never collides
    const recorded = JSON.parse(responseText(loadFixture("paypal/captures/pool-video"))) as Record<
      string,
      unknown
    >;
    expect([recorded["status"], recorded["status_details"]]).toEqual([
      "PENDING",
      { reason: "PENDING_REVIEW" },
    ]);
    const capture = {
      ...recorded,
      id: captureId,
      custom_id: pool,
      supplementary_data: { related_ids: { order_id: orderId } },
      create_time: new Date(now.getTime() - 60_000).toISOString(),
      update_time: new Date(now.getTime() - 60_000).toISOString(),
    };
    const recordedOrder = JSON.parse(responseText(loadFixture("paypal/orders/pool/get-order-video"))) as {
      purchase_units: Record<string, unknown>[];
    } & Record<string, unknown>;
    // the capture call answers with the recorded (COMPLETED) order; the APPROVED read before it can't be
    // recorded after the fact (PayPal reports COMPLETED once captured), so it carries the status only
    const order = (status: string, captures: unknown[]) =>
      status === "APPROVED"
        ? { id: orderId, status, purchase_units: [{ custom_id: pool }] }
        : {
            ...recordedOrder,
            id: orderId,
            status,
            purchase_units: [{ ...recordedOrder.purchase_units[0], custom_id: pool, payments: { captures } }],
          };
    let captureRequestId: string | null = null;
    server.use(
      http.get(`${BASE}/v2/checkout/orders/${orderId}`, () => HttpResponse.json(order("APPROVED", []))),
      http.post(`${BASE}/v2/checkout/orders/${orderId}/capture`, ({ request }) => {
        captureRequestId = request.headers.get("paypal-request-id");
        return HttpResponse.json(order("COMPLETED", [capture]), { status: 201 });
      }),
      http.get(`${BASE}/v2/payments/captures/${captureId}`, () => HttpResponse.json(capture)),
    );
    const { code, out } = await run(["capture"], now);
    expect(code).toBe(0);
    expect(out).toMatch(/pool rows checked, 0 failed/);
    expect(out).toContain(`${orderId}  held`);
    expect(out).toContain(`${captureId}  PENDING/PENDING_REVIEW`);
    expect(out).not.toMatch(CREDENTIAL);
    expect(captureRequestId).toBe(row.id); // the idempotency key: a re-run replays PayPal's first capture
    const after = (await platform(db).reviewHoldPool.list()).find((r) => r.id === row.id);
    expect([after?.state, after?.captureId, after?.captureStatus, after?.captureReason]).toEqual([
      "held",
      captureId,
      "PENDING",
      "PENDING_REVIEW",
    ]);

    // the capture sync job pool:capture enqueued, run as the worker would (M3-01 path)
    const job = await db.$client.query<{ data: { data: { captureId: string; source: "poll" } } }>(
      "select data from pgboss.job where name = 'paypal.capture.sync' and data->'data'->>'captureId' = $1",
      [captureId],
    );
    const input = job.rows[0]?.data.data;
    if (input === undefined) throw new Error("no capture sync job");
    const deps = {
      db,
      publisher: createPublisher(db, boss),
      captures: createPayPalCapturesClient(paypalHttp()),
      now: () => now,
    };
    expect(await withTransaction(db, (tx) => syncCapture(deps, input, ctx(tx, input, now)))).toBe("inserted");
    const ev = await db.$client.query<{ payload: unknown }>(
      "select payload from outbox where topic = 'payment.captured' and payload->'data'->>'captureId' = $1",
      [captureId],
    );
    const hd = { db, publisher: createPublisher(db, boss), now: () => now };
    const event = ev.rows[0]?.payload;
    expect(await withTransaction(db, (tx) => holdsForEvent(hd, event, ctx(tx, event, now)))).toBe("opened");
    const hold = await db.$client.query<{ workspace_id: string; reason: string; estimate_source: string }>(
      "select h.workspace_id, h.reason, h.estimate_source from holds h join payments p on p.id = h.payment_id where p.capture_id = $1",
      [captureId],
    );
    expect(hold.rows).toEqual([
      { workspace_id: pool, reason: "PENDING_REVIEW", estimate_source: "payment_review" },
    ]);

    // pool:status lists it with its age and expected release, and no credential
    const status = await run(["status"], now);
    expect(status.out).toMatch(
      new RegExp(`video\\s+held\\s+${orderId}\\s+${captureId}\\s+PENDING/PENDING_REVIEW\\s+1 min`),
    );
    expect(status.out).toContain("about 24 h after capture (estimated, rule payment_review)");
    expect(status.out).not.toMatch(CREDENTIAL);
  });

  it("pool:capture reports a row PayPal doesn't know and still checks the others (exit 1)", async () => {
    const now = isolatedNow();
    const pool = (await platform(db).reviewHoldPool.poolWorkspaceId()) ?? (await workspace("seller"));
    const orderId = fresh("X");
    await platform(db).reviewHoldPool.insert({
      orderId,
      poolWorkspaceId: pool,
      purpose: "judge",
      amount: "48.00",
      currency: "USD",
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    });
    server.use(
      http.get(`${BASE}/v2/checkout/orders/${orderId}`, () =>
        HttpResponse.json(
          { name: "RESOURCE_NOT_FOUND", message: "not found", debug_id: "abc123" },
          { status: 404 },
        ),
      ),
    );
    const { code, out } = await run(["capture"], now);
    expect(code).toBe(1);
    expect(out).toMatch(new RegExp(`judge\\s+${orderId}\\s+error`));
    expect(out).toMatch(/pool rows checked, 1 failed/);
    expect(out).not.toMatch(CREDENTIAL);
    // retire it so later runs on this database don't keep failing on it
    await db.$client.query("update review_hold_pool set state = 'not_held' where order_id = $1", [orderId]);
  });

  it("AC 1: an assignment moves exactly one held row, with its payment, hold and explanation, and audits it", async () => {
    const now = isolatedNow();
    const a = await seedHeld(now, { ageHours: 2 });
    const b = await seedHeld(now, { pool: a.pool, ageHours: 1 });
    const judge = await workspace();
    const got = await assign(judge, now);
    expect(got?.captureId).toBe(b.captureId); // the freshest first
    expect(await owners([b.orderId, b.captureId])).toEqual([
      { resource_type: "capture", workspace_id: judge, transferred_from: a.pool },
      { resource_type: "order", workspace_id: judge, transferred_from: a.pool },
    ]);
    expect(await workspaceOf("payments", b.paymentId)).toBe(judge);
    expect(await workspaceOf("holds", b.holdId)).toBe(judge);
    const expl = await db.$client.query<{ workspace_id: string }>(
      "select workspace_id from explanations where hold_id = $1",
      [b.holdId],
    );
    expect(expl.rows).toEqual([{ workspace_id: judge }]);
    // the other row did not move
    expect(await workspaceOf("payments", a.paymentId)).toBe(a.pool);
    expect((await owners([a.captureId]))[0]?.workspace_id).toBe(a.pool);
    const audit = await db.$client.query<{
      action: string;
      detail: { captureId: string; fromWorkspaceId: string };
    }>("select action, detail from audit_log where workspace_id = $1 and action = 'pool.assigned'", [judge]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.detail).toMatchObject({ captureId: b.captureId, fromWorkspaceId: a.pool });
    expect((await platform(db).reviewHoldPool.assignedTo(judge))?.id).toBe(b.poolId);
    // the judge's holds API reads it now (workspace-scoped)
    expect((await forWorkspace(db, judge).payments.get(b.paymentId))?.captureId).toBe(b.captureId);
    expect(await forWorkspace(db, a.pool as WorkspaceId).payments.get(b.paymentId)).toBeNull();
  });

  it("AC 1: two parallel assignments never get the same capture", async () => {
    const now = isolatedNow();
    const one = await seedHeld(now);
    const [j1, j2] = [await workspace(), await workspace()];
    const results = await Promise.all([assign(j1, now), assign(j2, now)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.find((r) => r !== null)?.captureId).toBe(one.captureId);
    const audits = await db.$client.query<{ n: number }>(
      "select count(*)::int as n from audit_log where workspace_id = any($1) and action = 'pool.assigned'",
      [[j1, j2]],
    );
    expect(audits.rows[0]?.n).toBe(1);

    // with two held rows, two parallel judges get one each, never the same
    const later = new Date(now.getTime() + 30 * 24 * 3_600_000);
    const x = await seedHeld(later);
    const y = await seedHeld(later, { pool: x.pool });
    const [j3, j4] = [await workspace(), await workspace()];
    const both = await Promise.all([assign(j3, later), assign(j4, later)]);
    expect(new Set(both.map((r) => r?.captureId))).toEqual(new Set([x.captureId, y.captureId]));
  });

  it("AC 2: refuses rows that are not pool-owned, released, or 20 h old", async () => {
    const now = isolatedNow();
    const judge = await workspace();
    const other = await workspace();
    const foreign = await seedHeld(now, { owner: other }); // the capture belongs to another workspace
    const released = await seedHeld(now, { pool: foreign.pool, status: "COMPLETED" }); // PayPal released it
    const old = await seedHeld(now, { pool: foreign.pool, ageHours: 20 });
    const markedReleased = await seedHeld(now, { pool: foreign.pool });
    await platform(db).reviewHoldPool.markReleased(markedReleased.poolId, "COMPLETED");
    const video = await seedHeld(now, { pool: foreign.pool, purpose: "video" }); // judges never get the video pool
    expect(await assign(judge, now)).toBeNull();
    for (const s of [foreign, released, old, markedReleased, video]) {
      expect(await workspaceOf("payments", s.paymentId)).toBe(s.pool);
    }
    expect(await platform(db).reviewHoldPool.assignedTo(judge)).toBeNull();
    // the video row goes only through pool:assign
    const owner = await workspace("seller");
    const v = await run(["assign", "--workspace", owner], now);
    expect([v.code, v.out]).toEqual([
      0,
      `assigned capture ${video.captureId} (order ${video.orderId}) to workspace ${owner}`,
    ]);
    expect((await run(["assign", "--workspace", owner], now)).code).toBe(1);
  });

  it("ADR 0019: a moved capture still syncs into the judge workspace with the pool's custom_id", async () => {
    const now = isolatedNow();
    const s = await seedHeld(now);
    const judge = await workspace();
    await assign(judge, now);
    const shape = JSON.parse(responseText(loadFixture("paypal/orders/get-capture-a"))) as Record<
      string,
      unknown
    >;
    const capture = {
      ...shape,
      id: s.captureId,
      status: "COMPLETED",
      status_details: undefined,
      amount: { currency_code: "USD", value: "64.00" },
      custom_id: s.pool, // PayPal can't change it after capture
      supplementary_data: { related_ids: { order_id: s.orderId } },
      create_time: new Date(now.getTime() - 3_600_000).toISOString(),
      update_time: now.toISOString(),
    };
    server.use(http.get(`${BASE}/v2/payments/captures/${s.captureId}`, () => HttpResponse.json(capture)));
    const deps = {
      db,
      publisher: createPublisher(db, boss),
      captures: createPayPalCapturesClient(paypalHttp()),
      now: () => now,
    };
    const input = { captureId: s.captureId, source: "poll" as const };
    expect(await withTransaction(db, (tx) => syncCapture(deps, input, ctx(tx, input, now)))).toBe("changed");
    expect(await workspaceOf("payments", s.paymentId)).toBe(judge);
    const q = await db.$client.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'paypal.capture.quarantined' and detail->>'captureId' = $1",
      [s.captureId],
    );
    expect(q.rows[0]?.n).toBe(0);
  });
});
