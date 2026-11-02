// M3-01 holds consumer over recorded captures. The M0-05 chargeback's three capture GETs
// (COMPLETED → PENDING/BUYER_COMPLAINT → COMPLETED) go through the real capture sync (msw serves the
// fixtures), and each event capture sync wrote is fed to the holds consumer: exactly one `hold.opened`
// and one `hold.released`; replaying the fixtures and the events again adds none. The spike's wallet
// review (PENDING_REVIEW → COMPLETED) opens a payment-review hold with its rule and estimate, then
// releases it at PayPal's update_time. A dispute.opened links without writing.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createHttpClient,
  createLogger,
  createPayPalCapturesClient,
  createTokenProvider,
} from "@cleared/adapters";
import { type WorkspaceId } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  holdsRepo,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../../../../packages/adapters/src/testing/fixture.ts";
import { dbAvailable, url } from "../../test/helpers.ts";
import { syncCapture } from "../jobs/capture-sync.ts";
import { holdsForEvent, type HoldOutcome } from "./holds.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
const created: string[] = [];
const NOW = new Date("2026-10-29T06:00:00Z");
const FULL = "paypal/disputes/full";

function ctx(tx: Parameters<Parameters<typeof withTransaction>[1]>[0], data: unknown) {
  const log = createLogger({ service: "worker-test", level: "silent" });
  const job = { id: randomUUID(), retryCount: 0, createdOn: NOW } as JobWithMetadata<unknown>;
  return { tx, log, job, envelope: { messageId: randomUUID(), correlationId: randomUUID(), data } };
}

function capturesClient() {
  const h = createHttpClient({ vendor: "paypal", timeoutMs: 2_000, maxRetries: 0, log: false });
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

/** Serves one recorded capture GET with a fresh capture id and the workspace as custom_id. */
function serve(fixture: string, captureId: string, ws: string): void {
  const f = loadFixture(`${FULL}/${fixture}`);
  const body = JSON.parse(responseText(f)) as Record<string, unknown>;
  body["id"] = captureId;
  body["custom_id"] = ws;
  server.use(
    http.get(
      `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
      () => HttpResponse.json(body),
      {
        once: true,
      },
    ),
  );
}

async function sync(captureId: string, fixture: string, ws: string): Promise<void> {
  serve(fixture, captureId, ws);
  const deps = { db, publisher: createPublisher(db, boss), captures: capturesClient(), now: () => NOW };
  const input = { captureId, source: "poll" as const };
  await withTransaction(db, (tx) => syncCapture(deps, input, ctx(tx, input)));
}

async function consume(event: unknown): Promise<HoldOutcome> {
  const deps = { db, publisher: createPublisher(db, boss), now: () => NOW };
  return withTransaction(db, (tx) => holdsForEvent(deps, event, ctx(tx, event)));
}

async function events(
  captureId: string,
  topics: readonly string[],
): Promise<{ topic: string; payload: unknown }[]> {
  const r = await db.$client.query<{ topic: string; payload: unknown }>(
    "select topic, payload from outbox where topic = any($2) and payload->'data'->>'captureId' = $1 order by created_at, id",
    [captureId, topics],
  );
  return r.rows;
}

const PAYMENT_EVENTS = ["payment.captured", "payment.status_changed"];
const HOLD_EVENTS = ["hold.opened", "hold.released"];
const freshCapture = () => `T${randomBytes(6).toString("hex").toUpperCase()}0000H`;

describe.skipIf(!dbAvailable)("holds consumer (integration)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
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

  it("M0-05 chargeback replay: one hold.opened, one hold.released; replaying twice adds none", async () => {
    const ws = await workspace();
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: ws,
    });
    const steps = ["capture-1-completed", "capture-2-pending", "capture-3-completed"];
    const outcomes: HoldOutcome[] = [];
    for (const step of steps) {
      await sync(captureId, step, ws);
      const all = await events(captureId, PAYMENT_EVENTS);
      const last = all.at(-1);
      outcomes.push(await consume(last?.payload));
    }
    expect(outcomes).toEqual(["unchanged", "opened", "released"]);
    const first = await events(captureId, HOLD_EVENTS);
    expect(first.map((e) => e.topic)).toEqual(["hold.opened", "hold.released"]);
    expect(first[0]?.payload).toMatchObject({ data: { captureId, reason: "BUYER_COMPLAINT" } });
    expect(first[1]?.payload).toMatchObject({ data: { captureId, releasedAt: "2026-10-29T05:38:42.000Z" } });

    // replay: the same fixtures (stale or unchanged) and every payment event again, twice
    for (let round = 0; round < 2; round += 1) {
      for (const step of steps) await sync(captureId, step, ws);
      for (const e of await events(captureId, PAYMENT_EVENTS))
        expect(await consume(e.payload)).toBe("unchanged");
    }
    expect((await events(captureId, HOLD_EVENTS)).length).toBe(2);
    const rows = await db.$client.query<{ state: string; estimate_source: string }>(
      "select h.state, h.estimate_source from holds h join payments p on p.id = h.payment_id where p.capture_id = $1",
      [captureId],
    );
    expect(rows.rows).toEqual([{ state: "released", estimate_source: "dispute_hold" }]);
  });

  it("wallet review (spike): PENDING_REVIEW opens a payment_review hold, released at PayPal's update_time", async () => {
    const ws = await workspace();
    const review = loadFixture("paypal/captures/pending-review").response.body as {
      capture_status: string;
      status_details: { reason: string };
    };
    const after = loadFixture("paypal/captures/pending-review-released").response.body as {
      status: string;
      create_time: string;
      update_time: string;
    };
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: ws,
    });
    const repos = forWorkspace(db, ws);
    const p = await repos.payments.insert({
      captureId,
      amount: "64.00",
      currency: "USD",
      status: review.capture_status,
      statusReason: review.status_details.reason,
      source: "webhook",
      paypalUpdatedAt: new Date(after.create_time),
    });
    const captured = {
      type: "payment.captured",
      version: 1,
      workspaceId: ws,
      occurredAt: "2026-10-26T11:24:22.000Z",
      data: {
        captureId,
        orderId: null,
        amount: { amount: "64.00", currency: "USD" },
        state: { status: "PENDING", reason: "PENDING_REVIEW" },
      },
    };
    expect(await consume(captured)).toBe("opened");
    expect(await consume(captured)).toBe("unchanged");
    const [view] = await holdsRepo(db, ws).listActive();
    expect(view?.hold).toMatchObject({
      type: "review",
      reason: "PENDING_REVIEW",
      state: "open",
      estimateSource: "payment_review",
      openedAt: new Date("2026-10-26T11:24:21Z"),
      estimatedReleaseAt: new Date("2026-10-27T11:24:21Z"),
    });
    expect(await holdsRepo(db, ws).heldTotals()).toEqual([{ value: "64.00", currency: "USD" }]);

    // PayPal released it (the spike's re-read): COMPLETED at update_time
    await repos.payments.update(p.id, {
      status: after.status,
      statusReason: null,
      paypalUpdatedAt: new Date(after.update_time),
    });
    expect(await consume(captured)).toBe("released");
    expect(await consume(captured)).toBe("unchanged");
    const released = await events(captureId, HOLD_EVENTS);
    expect(released.map((e) => e.topic)).toEqual(["hold.opened", "hold.released"]);
    expect(released[1]?.payload).toMatchObject({ data: { releasedAt: "2026-10-27T11:24:26.000Z" } });
    expect(await holdsRepo(db, ws).heldTotals()).toEqual([]);
    expect(await holdsRepo(db, ws).listActive()).toEqual([]);
  });

  it("dispute.opened links the dispute to the payment's hold without writing; an unknown dispute is a no-op", async () => {
    const ws = await workspace();
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: ws,
    });
    await sync(captureId, "capture-2-pending", ws);
    const [captured] = await events(captureId, PAYMENT_EVENTS);
    expect(await consume(captured?.payload)).toBe("opened");
    const repos = forWorkspace(db, ws);
    const payment = await repos.payments.getByCaptureId(captureId);
    const disputeId = `PP-R-H${randomBytes(4).toString("hex").toUpperCase()}`;
    await repos.disputes.insert({
      disputeId,
      paymentId: payment?.id ?? null,
      status: "WAITING_FOR_SELLER_RESPONSE",
      sellerResponseDueDate: new Date("2026-11-09T04:59:59Z"),
    });
    const opened = (id: string) => ({
      type: "dispute.opened",
      version: 1,
      workspaceId: ws,
      occurredAt: "2026-10-29T05:21:00.000Z",
      data: { disputeId: id, captureId, status: "OPEN", sellerResponseDueDate: null },
    });
    expect(await consume(opened(disputeId))).toBe("unchanged");
    expect(await consume(opened("PP-R-UNKNOWN"))).toBe("no_payment");
    const [view] = await holdsRepo(db, ws).listActive();
    expect(view?.dispute?.disputeId).toBe(disputeId);
    expect((await events(captureId, HOLD_EVENTS)).map((e) => e.topic)).toEqual(["hold.opened"]);
  });

  it("a hold on a capture another workspace owns is not readable from this one", async () => {
    const a = await workspace();
    const b = await workspace();
    const captureId = freshCapture();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: captureId,
      workspaceId: a,
    });
    await sync(captureId, "capture-2-pending", a);
    const [captured] = await events(captureId, PAYMENT_EVENTS);
    expect(await consume(captured?.payload)).toBe("opened");
    const [view] = await holdsRepo(db, a).listActive();
    expect(view).toBeDefined();
    expect(await holdsRepo(db, b).view(view?.hold.id ?? "")).toBeNull();
    expect(await holdsRepo(db, b).listActive()).toEqual([]);
  });
});
