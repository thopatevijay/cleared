// M3-08 AC 2: replaying the M0-05 dispute fixture produces one `dispute_opened` notification (with its one
// email job); replaying again adds none. Plus `hold.opened` → one `hold_opened` with the payment's amount.
// The fixture is the recorded WAITING_FOR_SELLER_RESPONSE GET, served by msw; the events go through the real
// outbox and the idempotent consumer (`consumeOne`), as the worker runs them.
import { randomUUID } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import { WorkspaceIdSchema, type HoldId, type CaptureId, type Instant } from "@cleared/core";
import {
  closeDb,
  createDb,
  createPublisher,
  createQueue,
  forWorkspace,
  NOTIFICATION_SEND_EMAIL_QUEUE,
  platform,
  withTransaction,
  type JobWithMetadata,
  type Queue,
} from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { disputesClient, freshIds, serveDispute, STATE } from "../../test/disputes-support.ts";
import { consumeOne } from "../consume.ts";
import { syncDispute } from "../jobs/dispute-sync.ts";
import { disputeOpenedHandler, holdOpenedHandler } from "./notifications.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
const log = createLogger({ service: "worker-test", level: "silent" });
const NOW = new Date("2026-11-02T12:00:00Z");
const deps = () => ({ db, publisher: createPublisher(db, boss) });
const consumeDeps = { db, log, now: () => NOW };

async function workspace(): Promise<string> {
  const ws = await platform(db).workspaces.create({
    kind: "seller",
    locale: "en",
    timezone: "Asia/Kolkata",
    baseCurrency: "USD",
  });
  return ws.id;
}

const job = (envelope: unknown) =>
  ({ id: randomUUID(), retryCount: 0, data: envelope }) as JobWithMetadata<unknown>;

/** The dispute sync over the recorded fixture: the mirror row and, on insert, `dispute.opened` in the outbox. */
async function replay(ws: string, ids: ReturnType<typeof freshIds>): Promise<void> {
  serveDispute(server, STATE.waiting, ids, ws);
  const sync = { ...deps(), disputes: disputesClient(server), now: () => NOW };
  const input = { disputeId: ids.disputeId, source: "poll" as const };
  await withTransaction(db, (tx) =>
    syncDispute(sync, input, {
      tx,
      log,
      job: { id: randomUUID(), retryCount: 0, createdOn: NOW } as JobWithMetadata<unknown>,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: input },
    }),
  );
}

/** Every `dispute.opened` outbox row of the dispute, delivered to the consumer as the worker would. */
async function deliverOpened(disputeId: string, fresh = false): Promise<number> {
  const rows = await db.$client.query<{ id: string; payload: unknown }>(
    "select id, payload from outbox where topic = 'dispute.opened' and payload->'data'->>'disputeId' = $1",
    [disputeId],
  );
  for (const r of rows.rows) {
    // `fresh`: a re-emitted event with a new message id (receipt dedupe can't help; the dedupe key must)
    const envelope = { messageId: fresh ? randomUUID() : r.id, correlationId: randomUUID(), data: r.payload };
    await consumeOne(consumeDeps, "dispute.opened", disputeOpenedHandler(deps()), job(envelope));
  }
  return rows.rows.length;
}

async function emailJobs(notificationId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*) as n from pgboss.job where name = $1 and data->'data'->>'notificationId' = $2",
    [NOTIFICATION_SEND_EMAIL_QUEUE, notificationId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe.skipIf(!dbAvailable)("notification consumers", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterAll(async () => {
    server.close();
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("the M0-05 fixture replayed twice: one dispute_opened (one email job); replays add none", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await platform(db).resourceOwners.claim({
      resourceType: "capture",
      resourceId: ids.captureId,
      workspaceId: ws,
    });
    await replay(ws, ids);
    await replay(ws, ids);
    expect(await deliverOpened(ids.disputeId)).toBe(1);
    await deliverOpened(ids.disputeId);
    await deliverOpened(ids.disputeId, true);

    const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
    const rows = (await repos.notifications.latest(50)).filter((n) => n.kind === "dispute_opened");
    expect(rows).toHaveLength(1);
    const [n] = rows;
    const dispute = await repos.disputes.getByDisputeId(ids.disputeId);
    expect(n).toMatchObject({ refType: "dispute", refId: dispute?.id, disputeId: dispute?.id, readAt: null });
    expect(n?.dedupeKey).toBe(`dispute_opened:${dispute?.id ?? ""}:once`);
    // only amount, reason code and dates are stored
    expect(Object.keys(n?.data as object).sort()).toEqual([
      "amount",
      "dueDate",
      "paymentId",
      "reason",
      "releaseDate",
    ]);
    expect(await emailJobs(n?.id ?? "")).toBe(1);
  });

  it("hold.opened → one hold_opened with the payment's amount; a replay adds none", async () => {
    const ws = await workspace();
    const repos = forWorkspace(db, WorkspaceIdSchema.parse(ws));
    const captureId = freshIds().captureId;
    const payment = await repos.payments.insert({
      captureId,
      amount: "64.00",
      currency: "USD",
      status: "PENDING",
      statusReason: "PENDING_REVIEW",
      source: "webhook",
    });
    const hold = await repos.holds.insert({
      paymentId: payment.id,
      type: "PENDING",
      reason: "PENDING_REVIEW",
      openedAt: NOW,
    });
    const event = {
      type: "hold.opened",
      version: 1,
      workspaceId: ws,
      occurredAt: NOW.toISOString() as Instant,
      data: { holdId: hold.id as HoldId, captureId: captureId as CaptureId, reason: "PENDING_REVIEW" },
    };
    for (let i = 0; i < 2; i += 1) {
      const envelope = { messageId: randomUUID(), correlationId: randomUUID(), data: event };
      await consumeOne(consumeDeps, "hold.opened", holdOpenedHandler(deps()), job(envelope));
    }
    const rows = (await repos.notifications.latest(50)).filter((n) => n.kind === "hold_opened");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refType: "hold", refId: hold.id, disputeId: null });
    expect(rows[0]?.data).toMatchObject({
      amount: { amount: "64.00", currency: "USD" },
      reason: "PENDING_REVIEW",
      paymentId: payment.id,
    });
  });
});
