// `paypal.capture.sync` over recorded PayPal capture GETs (M1-04 AC: sync fixture replay, stale replay,
// one event per change, ownership + quarantine with an injected clock). The capture GET is served by msw
// from the fixture; only `custom_id` is rewritten to the test's fresh workspace (a capture id is unique
// across the whole database, so each test first removes what an earlier run left for it).
import { randomUUID } from "node:crypto";
import {
  createHttpClient,
  createLogger,
  createPayPalCapturesClient,
  createTokenProvider,
} from "@cleared/adapters";
import {
  createPublisher,
  createQueue,
  forWorkspace,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import {
  OwnerPendingError,
  syncCapture,
  UNOWNED_RETRY_WINDOW_MS,
  type CaptureSyncInput,
  type SyncOutcome,
} from "../../src/jobs/capture-sync.ts";
import { dbAvailable, url } from "../helpers.ts";
import { closeDb, createDb } from "@cleared/db";
import { WorkspaceIdSchema } from "@cleared/core";

const server = setupServer();
const db = createDb(url);
let boss: Queue;

/** Serves one capture GET from `fixture`, with `custom_id` replaced when given. */
function serveCapture(fixture: string, customId?: string): string {
  const f = loadFixture(fixture);
  const body = JSON.parse(responseText(f)) as Record<string, unknown>;
  if (customId !== undefined) body["custom_id"] = customId;
  server.use(
    http.get(f.request.url, () => HttpResponse.json(body, { status: f.response.status }), { once: true }),
  );
  return String(body["id"]);
}

function capturesClient() {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0 });
  const tokens = createTokenProvider({
    http: h,
    baseUrl: "https://api-m.sandbox.paypal.com",
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

/** Workspaces this run created: events are counted per run, and their jobs removed afterwards. */
const created: string[] = [];

async function workspace(): Promise<string> {
  const ws = await platform(db).workspaces.create({
    kind: "demo",
    locale: "en",
    timezone: "UTC",
    baseCurrency: "USD",
  });
  created.push(ws.id);
  return ws.id;
}

async function forget(captureId: string, orderId: string | null): Promise<void> {
  await db.$client.query(
    "delete from proof_packs where payment_id in (select id from payments where capture_id = $1)",
    [captureId],
  );
  await db.$client.query("delete from payments where capture_id = $1", [captureId]);
  await db.$client.query("delete from paypal_resource_owner where resource_id = any($1)", [
    [captureId, orderId].filter((x) => x !== null),
  ]);
}

async function webhookEvent(receivedAt: Date): Promise<string> {
  const row = await platform(db).webhookEvents.insertRaw({
    provider: "paypal",
    eventId: `WH-TEST-${randomUUID()}`,
    type: "PAYMENT.CAPTURE.COMPLETED",
    raw: {},
    verified: true,
    receivedAt,
  });
  if (row === null) throw new Error("event insert");
  return row.id;
}

async function run(input: CaptureSyncInput, now: Date, createdOn = now): Promise<SyncOutcome> {
  const deps = { db, publisher: createPublisher(db, boss), captures: capturesClient(), now: () => now };
  const log = createLogger({ service: "worker-test", level: "silent" });
  const job = { id: randomUUID(), retryCount: 0, createdOn } as JobWithMetadata<unknown>;
  return withTransaction(db, (tx) =>
    syncCapture(deps, input, {
      tx,
      log,
      job,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: input },
    }),
  );
}

async function events(captureId: string): Promise<string[]> {
  const r = await db.$client.query<{ topic: string }>(
    `select topic from outbox where payload->'data'->>'captureId' = $1
       and payload->>'workspaceId' = any($2) order by created_at`,
    [captureId, created],
  );
  return r.rows.map((x) => x.topic);
}

const T0 = new Date("2026-10-30T12:00:00Z");

describe.skipIf(!dbAvailable)("paypal.capture.sync (capture-sync)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(async () => {
    server.close();
    // Nothing consumes these events here: drop their jobs and mark the rows published, so a worker
    // started by a later test file (process.test.ts) neither consumes nor relays them.
    await db.$client.query(
      "delete from pgboss.job where name in ('payment.captured', 'payment.status_changed') and data->>'workspaceId' = any($1)",
      [created],
    );
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("owned: the recorded capture becomes a payment row (status, reason, money, source=webhook); event processed", async () => {
    const ws = await workspace();
    const f = loadFixture("paypal/orders/test-payment/get-capture");
    const body = f.response.body as { id: string; supplementary_data: { related_ids: { order_id: string } } };
    const orderId = body.supplementary_data.related_ids.order_id;
    await forget(body.id, orderId);
    await platform(db).resourceOwners.claim({ resourceType: "order", resourceId: orderId, workspaceId: ws });
    const captureId = serveCapture("paypal/orders/test-payment/get-capture", ws);
    const eventId = await webhookEvent(T0);

    expect(await run({ captureId, eventId, source: "webhook" }, T0)).toBe("inserted");

    const p = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).payments.getByCaptureId(captureId);
    expect(p).toMatchObject({
      orderId,
      status: "COMPLETED",
      statusReason: null,
      amount: "42.00",
      currency: "USD",
      receivableAmount: "40.42",
      source: "webhook",
    });
    expect(p?.paypalUpdatedAt?.toISOString()).toBe("2026-10-30T17:08:28.000Z");
    expect(await platform(db).resourceOwners.get("capture", captureId)).toMatchObject({ workspaceId: ws });
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({ status: "processed" });
    expect(await events(captureId)).toEqual(["payment.captured"]);
    // M2-05 (BL-01 6536606046): the pack is born with the payment, empty
    const pack = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).proofPacks.getByPaymentId(p?.id ?? "");
    expect(pack).toMatchObject({ state: "empty", checkedAt: null });
  });

  it("status follows PayPal (COMPLETED → PENDING/BUYER_COMPLAINT); an older update_time changes nothing; a repeat emits nothing", async () => {
    const ws = await workspace();
    const first = loadFixture("paypal/disputes/full/capture-1-completed").response.body as { id: string };
    await forget(first.id, null);
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: first.id,
      workspaceId: ws,
    });
    const input = (captureId: string): CaptureSyncInput => ({ captureId, source: "webhook" });
    const repo = forWorkspace(db, WorkspaceIdSchema.parse(ws)).payments;

    const id = serveCapture("paypal/disputes/full/capture-1-completed", ws);
    expect(await run(input(id), T0)).toBe("inserted");
    serveCapture("paypal/disputes/full/capture-2-pending", ws);
    expect(await run(input(id), T0)).toBe("changed");
    expect(await repo.getByCaptureId(id)).toMatchObject({
      status: "PENDING",
      statusReason: "BUYER_COMPLAINT",
    });

    serveCapture("paypal/disputes/full/capture-1-completed", ws); // replayed out of order: older update_time
    expect(await run(input(id), T0)).toBe("stale");
    expect(await repo.getByCaptureId(id)).toMatchObject({
      status: "PENDING",
      statusReason: "BUYER_COMPLAINT",
    });

    serveCapture("paypal/disputes/full/capture-2-pending", ws); // the same state again
    expect(await run(input(id), T0)).toBe("unchanged");
    expect(await events(id)).toEqual(["payment.captured", "payment.status_changed"]);
  });

  it("running sync twice on the same capture emits one event", async () => {
    const ws = await workspace();
    const body = loadFixture("paypal/orders/get-capture-a").response.body as { id: string };
    await forget(body.id, null);
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: body.id,
      workspaceId: ws,
    });
    serveCapture("paypal/orders/get-capture-a", ws);
    serveCapture("paypal/orders/get-capture-a", ws);
    await run({ captureId: body.id, source: "webhook" }, T0);
    await run({ captureId: body.id, source: "webhook" }, T0);
    expect(await events(body.id)).toEqual(["payment.captured"]);
  });

  it("unowned: retried inside the 10-minute window, then quarantined with a platform audit row", async () => {
    const body = loadFixture("paypal/disputes/accept/capture-1-completed").response.body as {
      id: string;
      supplementary_data: { related_ids: { order_id: string } };
    };
    await forget(body.id, body.supplementary_data.related_ids.order_id);
    const eventId = await webhookEvent(T0);
    const input: CaptureSyncInput = { captureId: body.id, eventId, source: "webhook" };

    serveCapture("paypal/disputes/accept/capture-1-completed");
    const inside = new Date(T0.getTime() + UNOWNED_RETRY_WINDOW_MS - 1_000);
    await expect(run(input, inside)).rejects.toBeInstanceOf(OwnerPendingError);
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({ status: "received" });

    serveCapture("paypal/disputes/accept/capture-1-completed");
    const after = new Date(T0.getTime() + UNOWNED_RETRY_WINDOW_MS + 1_000);
    expect(await run(input, after)).toBe("quarantined");
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({
      status: "quarantined",
      quarantineReason: "unowned",
    });
    const audit = await db.$client.query<{
      workspace_id: string | null;
      actor: string;
      detail: { eventId: string };
    }>(
      "select workspace_id, actor, detail from audit_log where action = 'paypal.capture.quarantined' and detail->>'eventId' = $1",
      [eventId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      workspace_id: null,
      actor: "system",
      detail: { reason: "unowned", captureId: body.id },
    });
    expect(await db.$client.query("select 1 from payments where capture_id = $1", [body.id])).toMatchObject({
      rowCount: 0,
    });
  });

  it("mismatch: custom_id names another workspace → quarantined at once, audited on the owner workspace", async () => {
    const owner = await workspace();
    const other = await workspace();
    const body = loadFixture("paypal/disputes/accept/capture-2-pending").response.body as { id: string };
    await forget(body.id, null);
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: body.id,
      workspaceId: owner,
    });
    const eventId = await webhookEvent(T0);
    serveCapture("paypal/disputes/accept/capture-2-pending", other);

    expect(await run({ captureId: body.id, eventId, source: "webhook" }, T0)).toBe("quarantined");
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({
      status: "quarantined",
      quarantineReason: "custom_id_mismatch",
    });
    const audit = await db.$client.query<{ workspace_id: string | null }>(
      "select workspace_id from audit_log where action = 'paypal.capture.quarantined' and detail->>'eventId' = $1",
      [eventId],
    );
    expect(audit.rows).toEqual([{ workspace_id: owner }]);
    expect(
      await forWorkspace(db, WorkspaceIdSchema.parse(owner)).payments.getByCaptureId(body.id),
    ).toBeNull();
  });
});
