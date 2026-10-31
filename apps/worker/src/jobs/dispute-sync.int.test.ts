// `paypal.dispute.sync` over the recorded M0-05 dispute GETs (M2-06 AC): fixture replay mirror and
// allowed actions, out-of-order webhooks, duplicate jobs, quarantine, and the deadline applied on sync.
import { randomUUID } from "node:crypto";
import { createLogger } from "@cleared/adapters";
import { addMinutes, WorkspaceIdSchema, type Instant } from "@cleared/core";
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
} from "@cleared/db";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import {
  disputesClient,
  freshIds,
  RECORDED_DUE,
  serveDispute,
  STATE,
  type Ids,
} from "../../test/disputes-support.ts";
import { OwnerPendingError, UNOWNED_RETRY_WINDOW_MS } from "./capture-sync.ts";
import { syncDispute, type DisputeSyncInput, type DisputeSyncOutcome } from "./dispute-sync.ts";

const server = setupServer();
const db = createDb(url);
let boss: Queue;
const created: string[] = [];
const T0 = new Date("2026-10-30T12:00:00Z");

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

async function ownCapture(ws: string, ids: Ids): Promise<void> {
  await platform(db).resourceOwners.claim({
    resourceType: "capture",
    resourceId: ids.captureId,
    workspaceId: ws,
  });
}

async function webhookEvent(type: string, receivedAt: Date): Promise<string> {
  const row = await platform(db).webhookEvents.insertRaw({
    provider: "paypal",
    eventId: `WH-TEST-${randomUUID()}`,
    type,
    raw: {},
    verified: true,
    receivedAt,
  });
  if (row === null) throw new Error("event insert");
  return row.id;
}

async function run(input: DisputeSyncInput, now: Date, createdOn = now): Promise<DisputeSyncOutcome> {
  const deps = { db, publisher: createPublisher(db, boss), disputes: disputesClient(server), now: () => now };
  const log = createLogger({ service: "worker-test", level: "silent" });
  const job = { id: randomUUID(), retryCount: 0, createdOn } as JobWithMetadata<unknown>;
  return withTransaction(db, (tx) =>
    syncDispute(deps, input, {
      tx,
      log,
      job,
      envelope: { messageId: randomUUID(), correlationId: randomUUID(), data: input },
    }),
  );
}

async function topics(disputeId: string): Promise<string[]> {
  const r = await db.$client.query<{ topic: string }>(
    "select topic from outbox where payload->'data'->>'disputeId' = $1 order by created_at, id",
    [disputeId],
  );
  return r.rows.map((x) => x.topic);
}

async function captureSyncJobs(captureId: string): Promise<number> {
  const r = await db.$client.query<{ n: string }>(
    "select count(*) as n from pgboss.job where name = 'paypal.capture.sync' and data->'data'->>'captureId' = $1",
    [captureId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

const repo = (ws: string) => forWorkspace(db, WorkspaceIdSchema.parse(ws)).disputes;
const webhook = (disputeId: string, eventId?: string): DisputeSyncInput => ({
  disputeId,
  source: "webhook",
  ...(eventId === undefined ? {} : { eventId }),
});

describe.skipIf(!dbAvailable)("paypal.dispute.sync (dispute-sync)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    boss = await createQueue(db, { background: false, max: 2 });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(async () => {
    server.close();
    // Nothing consumes these here: drop the jobs and mark the outbox rows published (process.test.ts).
    await db.$client.query(
      "delete from pgboss.job where name in ('dispute.opened', 'dispute.status_changed', 'paypal.capture.sync') and data->>'workspaceId' = any($1)",
      [created],
    );
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("replays M0-05: UNDER_REVIEW → provide_supporting_info, then WAITING_FOR_SELLER_RESPONSE → accept_claim, provide_evidence + due date", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await ownCapture(ws, ids);
    const payment = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).payments.insert({
      captureId: ids.captureId,
      orderId: null,
      amount: "64.00",
      currency: "USD",
      status: "PENDING",
      statusReason: "BUYER_COMPLAINT",
      source: "webhook",
    });

    serveDispute(server, STATE.underReview, ids, ws);
    expect(await run(webhook(ids.disputeId), T0)).toBe("inserted");
    expect(await repo(ws).getByDisputeId(ids.disputeId)).toMatchObject({
      status: "UNDER_REVIEW",
      stage: "CHARGEBACK",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      sellerResponseDueDate: null,
      allowedActions: ["provide_supporting_info"],
      paymentId: payment.id,
      outcome: null,
      deadlineState: "ok",
    });

    serveDispute(server, STATE.waiting, ids, ws);
    expect(await run(webhook(ids.disputeId), T0)).toBe("changed");
    const row = await repo(ws).getByDisputeId(ids.disputeId);
    expect(row).toMatchObject({
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "CHARGEBACK",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      allowedActions: ["accept_claim", "provide_evidence"],
    });
    expect(row?.sellerResponseDueDate?.toISOString()).toBe(RECORDED_DUE);
    expect(row?.paypalUpdatedAt?.toISOString()).toBe("2026-10-29T05:20:34.178Z");
    expect(await topics(ids.disputeId)).toEqual(["dispute.opened", "dispute.status_changed"]);
    // M2-09: the status change is also an audit row (the workspace audit log's "mirrored PayPal status")
    const audit = await db.$client.query<{ actor: string; detail: Record<string, unknown> }>(
      "select actor, detail from audit_log where workspace_id = $1 and action = 'dispute.status_changed'",
      [ws],
    );
    expect(audit.rows).toEqual([
      {
        actor: "system",
        detail: {
          paypalDisputeId: ids.disputeId,
          from: "UNDER_REVIEW",
          to: "WAITING_FOR_SELLER_RESPONSE",
          outcomeCode: null,
          outcomeReason: null,
        },
      },
    ]);
    // owner inherited from the capture and claimed for the dispute; the hold is re-fetched on each change
    expect(await platform(db).resourceOwners.get("dispute", ids.disputeId)).toMatchObject({
      workspaceId: ws,
    });
    expect(await captureSyncJobs(ids.captureId)).toBe(2);
  });

  it("out of order: RESOLVED delivered before UPDATED ends RESOLVED with RESOLVED_WITH_PAYOUT / REPRESENTED_BY_PAYPAL", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await ownCapture(ws, ids);
    const resolvedEvent = await webhookEvent("CUSTOMER.DISPUTE.RESOLVED", T0);
    const updatedEvent = await webhookEvent("CUSTOMER.DISPUTE.UPDATED", T0);

    serveDispute(server, STATE.resolved, ids, ws);
    expect(await run(webhook(ids.disputeId, resolvedEvent), T0)).toBe("inserted");
    // the UPDATED delivery's re-fetch answers an older state (update_time earlier): never overwrites
    serveDispute(server, STATE.waiting, ids, ws);
    expect(await run(webhook(ids.disputeId, updatedEvent), T0)).toBe("stale");

    const row = await repo(ws).getByDisputeId(ids.disputeId);
    expect(row).toMatchObject({
      status: "RESOLVED",
      outcome: {
        outcome_code: "RESOLVED_WITH_PAYOUT",
        outcome_reason: "REPRESENTED_BY_PAYPAL",
        amount_refunded: { currency_code: "USD", value: "64.00" },
      },
      allowedActions: [],
      sellerResponseDueDate: null,
    });
    expect(row?.paypalUpdatedAt?.toISOString()).toBe("2026-10-29T05:38:33.397Z");
    for (const id of [resolvedEvent, updatedEvent]) {
      expect(await platform(db).webhookEvents.get(id)).toMatchObject({ status: "processed" });
    }
    expect(await topics(ids.disputeId)).toEqual(["dispute.opened"]);
  });

  it("duplicate jobs for the same PayPal state write no second outbox row", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await ownCapture(ws, ids);
    serveDispute(server, STATE.waiting, ids, ws);
    serveDispute(server, STATE.waiting, ids, ws);
    serveDispute(server, STATE.waiting, ids, ws);
    expect(await run(webhook(ids.disputeId), T0)).toBe("inserted");
    expect(await run(webhook(ids.disputeId), T0)).toBe("unchanged");
    expect(await run({ disputeId: ids.disputeId, source: "poll" }, T0)).toBe("unchanged");
    expect(await topics(ids.disputeId)).toEqual(["dispute.opened"]);
    expect(await captureSyncJobs(ids.captureId)).toBe(1);
  });

  it("a dispute whose capture has no owner: retried inside the window, then quarantined (no row, audit entry)", async () => {
    const ids = freshIds();
    const eventId = await webhookEvent("CUSTOMER.DISPUTE.CREATED", T0);
    const input = webhook(ids.disputeId, eventId);

    serveDispute(server, STATE.open, ids, null);
    const inside = new Date(T0.getTime() + UNOWNED_RETRY_WINDOW_MS - 1_000);
    await expect(run(input, inside)).rejects.toBeInstanceOf(OwnerPendingError);
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({ status: "received" });

    serveDispute(server, STATE.open, ids, null);
    const after = new Date(T0.getTime() + UNOWNED_RETRY_WINDOW_MS + 1_000);
    expect(await run(input, after)).toBe("quarantined");

    const rows = await db.$client.query("select 1 from disputes where dispute_id = $1", [ids.disputeId]);
    expect(rows.rowCount).toBe(0);
    expect(await platform(db).webhookEvents.get(eventId)).toMatchObject({
      status: "quarantined",
      quarantineReason: "unowned",
    });
    const audit = await db.$client.query<{
      workspace_id: string | null;
      actor: string;
      detail: Record<string, unknown>;
    }>(
      "select workspace_id, actor, detail from audit_log where action = 'paypal.dispute.quarantined' and detail->>'disputeId' = $1",
      [ids.disputeId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      workspace_id: null,
      actor: "system",
      detail: { reason: "unowned", captureId: ids.captureId, eventId },
    });
    expect(await platform(db).resourceOwners.get("dispute", ids.disputeId)).toBeNull();
    expect(await topics(ids.disputeId)).toEqual([]);
  });

  it("a `custom` naming another workspace is quarantined at once (mismatch), audited on the owner", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await ownCapture(ws, ids);
    serveDispute(server, STATE.open, ids, randomUUID());
    expect(await run(webhook(ids.disputeId), T0)).toBe("quarantined");
    const audit = await db.$client.query<{ workspace_id: string }>(
      "select workspace_id from audit_log where action = 'paypal.dispute.quarantined' and detail->>'disputeId' = $1",
      [ids.disputeId],
    );
    expect(audit.rows).toEqual([{ workspace_id: ws }]);
    expect(await repo(ws).getByDisputeId(ids.disputeId)).toBeNull();
  });

  it("each sync applies the deadline: at due − 71 h the dispute is t72 with one 72 h alert", async () => {
    const ws = await workspace();
    const ids = freshIds();
    await ownCapture(ws, ids);
    const now = new Date(addMinutes(RECORDED_DUE as Instant, -71 * 60));
    serveDispute(server, STATE.waiting, ids, ws);
    serveDispute(server, STATE.waiting, ids, ws);
    await run(webhook(ids.disputeId), now);
    await run(webhook(ids.disputeId), now);
    const row = await repo(ws).getByDisputeId(ids.disputeId);
    expect(row?.deadlineState).toBe("t72");
    const notes = await repo(ws).notificationsFor(row?.id ?? "");
    expect(notes.map((n) => n.kind)).toEqual(["dispute_deadline_72h"]);
  });
});
