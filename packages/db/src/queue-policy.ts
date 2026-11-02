// Queue definitions and retry policy (ADR 0004, architecture §12). pg-boss 12 needs every queue created
// before `send`/`work`; jobs inherit the queue's retry, expiry and dead-letter settings at insert time.
// Moved here from apps/worker in M1-04 (BL-01 6528386693): `migrate` creates every known queue, so the
// web can enqueue and emit before the worker has ever booted.
import { DOMAIN_EVENT_TYPES } from "@cleared/core";
import type { Queue } from "./queue.ts";

/** Retries after the first attempt, with exponential backoff and jitter (pg-boss `retryBackoff`). */
export const RETRY_LIMIT = 8;
/** First backoff step in seconds; attempt n waits about `RETRY_DELAY_SECONDS * 2^(n-1)` (x1 to x2 jitter). */
export const RETRY_DELAY_SECONDS = 2;
export const RETRY_DELAY_MAX_SECONDS = 300;
/** A dead-letter handler only logs and records, so it is short. */
export const DLQ_EXPIRE_SECONDS = 60;

export interface QueueSpec {
  readonly name: string;
  /** How long one attempt may stay active before pg-boss fails it (per queue, required). */
  readonly expireInSeconds: number;
  readonly retryLimit?: number;
  readonly retryDelay?: number;
}

export function dlqName(queue: string): string {
  return `${queue}.dlq`;
}

/** Creates (or updates) the queue and its dead-letter queue `<queue>.dlq`. */
export async function ensureQueue(boss: Queue, spec: QueueSpec): Promise<void> {
  const dlq = dlqName(spec.name);
  await upsertQueue(boss, dlq, { expireInSeconds: DLQ_EXPIRE_SECONDS, retryLimit: 2, retryDelay: 5 });
  await upsertQueue(boss, spec.name, {
    expireInSeconds: spec.expireInSeconds,
    retryLimit: spec.retryLimit ?? RETRY_LIMIT,
    retryDelay: spec.retryDelay ?? RETRY_DELAY_SECONDS,
    retryBackoff: true,
    retryDelayMax: RETRY_DELAY_MAX_SECONDS,
    deadLetter: dlq,
  });
}

interface QueueSettings {
  readonly expireInSeconds: number;
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff?: boolean;
  readonly retryDelayMax?: number;
  readonly deadLetter?: string;
}

/** `createQueue` keeps an existing queue's settings, so an existing queue is updated to match. */
async function upsertQueue(boss: Queue, name: string, settings: QueueSettings): Promise<void> {
  if (await boss.getQueue(name)) await boss.updateQueue(name, settings);
  else await boss.createQueue(name, settings);
}

/** Commands (not domain events) and their per-queue policy. */
export const PAYPAL_CAPTURE_SYNC_QUEUE = "paypal.capture.sync";
export const SANDBOX_TEST_PAYMENT_QUEUE = "sandbox.test_payment";
/** M2-06: re-fetch one dispute and upsert its mirror (`{disputeId, eventId?, source?}`). */
export const PAYPAL_DISPUTE_SYNC_QUEUE = "paypal.dispute.sync";
/** M2-06: the deadline watcher, scheduled every 15 minutes. */
export const DISPUTE_DEADLINE_WATCH_QUEUE = "dispute.deadline_watch";
export const DISPUTE_DEADLINE_WATCH_CRON = "*/15 * * * *";
/** M2-08: run the governed checks and the one PayPal write of an approved action (`{actionId, workspaceId}`). */
export const ACTION_EXECUTE_QUEUE = "action.execute";
/** M2-08: re-read the dispute after an `unknown` send (`{actionId, workspaceId, attempt, before}`). */
export const ACTION_RECONCILE_QUEUE = "action.reconcile";

/** M2-10: the judge scenario's step jobs (`{scenarioId, workspaceId}`); each acts only in its run state. */
export const SCENARIO_CAPTURE_QUEUE = "scenario.capture";
export const SCENARIO_SEED_PACK_QUEUE = "scenario.seed_pack";
export const SCENARIO_CHARGEBACK_QUEUE = "scenario.chargeback";
export const SCENARIO_POLL_QUEUE = "scenario.poll";
/** M2-10: the sandbox decision (adjudicate SELLER_FAVOR); never retried (Disputes writes aren't idempotent). */
export const SCENARIO_DECIDE_QUEUE = "scenario.decide";

/** M3-08: email one notification (`{notificationId, workspaceId}`); the in-app row is already committed. */
export const NOTIFICATION_SEND_EMAIL_QUEUE = "notification.send_email";
/** M3-07: render the pack's scope snapshot PDF (`{workspaceId, packId}`); idempotent on the input hash. */
export const SCOPE_SNAPSHOT_RENDER_QUEUE = "scope_snapshot.render";

export const COMMAND_QUEUES: readonly QueueSpec[] = [
  // Resend dedupes on the notification id (Idempotency-Key), so a retry never sends twice. 5 retries with
  // backoff (2, 4, 8, 16, 32 s + jitter) ≈ 1 min, then the DLQ (Sentry) and the row says `failed`.
  { name: NOTIFICATION_SEND_EMAIL_QUEUE, expireInSeconds: 60, retryLimit: 5 },
  // Pure rendering plus one insert keyed on (pack, input hash): a retry finds the row or writes it once.
  { name: SCOPE_SNAPSHOT_RENDER_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  // 12 retries with the 300 s cap ≈ 28 min minimum: longer than the 10-minute unowned-capture window.
  { name: PAYPAL_CAPTURE_SYNC_QUEUE, expireInSeconds: 60, retryLimit: 12 },
  { name: SANDBOX_TEST_PAYMENT_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  // Same 12 retries as capture sync: an unowned dispute waits out the 10-minute owner window.
  { name: PAYPAL_DISPUTE_SYNC_QUEUE, expireInSeconds: 60, retryLimit: 12 },
  // A missed tick is covered by the next one 15 minutes later (and by every sync).
  { name: DISPUTE_DEADLINE_WATCH_QUEUE, expireInSeconds: 120, retryLimit: 2 },
  // The send is guarded by the committed `executions` row: a retry never resends (it goes `unknown`).
  { name: ACTION_EXECUTE_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  // Each try schedules the next itself (2, 4, 8, 16 min); these retries only cover a failed re-read.
  { name: ACTION_RECONCILE_QUEUE, expireInSeconds: 60, retryLimit: 8 },
  // Orders replay a repeated PayPal-Request-Id; the run's state guard makes a re-delivery a no-op.
  { name: SCENARIO_CAPTURE_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  { name: SCENARIO_SEED_PACK_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  // A retry lists the capture's disputes first, so it adopts a chargeback that landed before a failure.
  { name: SCENARIO_CHARGEBACK_QUEUE, expireInSeconds: 120, retryLimit: 3 },
  { name: SCENARIO_POLL_QUEUE, expireInSeconds: 60, retryLimit: 5 },
  { name: SCENARIO_DECIDE_QUEUE, expireInSeconds: 60, retryLimit: 0 },
];

/** `evidence.added` (M2-03 extract) and `pack.extracted` (M2-04 scope check) run an agent (120 s wall clock). */
const EVENT_EXPIRE_SECONDS: Readonly<Record<string, number>> = {
  "evidence.added": 300,
  "pack.extracted": 300,
};

/** Every domain event type is a queue (M1-03: queue = outbox topic = `event.type`). */
export const EVENT_QUEUES: readonly QueueSpec[] = DOMAIN_EVENT_TYPES.map((name) => ({
  name,
  expireInSeconds: EVENT_EXPIRE_SECONDS[name] ?? 60,
}));

export const KNOWN_QUEUES: readonly QueueSpec[] = [...COMMAND_QUEUES, ...EVENT_QUEUES];

/** Creates every known queue (and its `.dlq`); run by `migrate`. Idempotent. */
export async function ensureKnownQueues(boss: Queue): Promise<number> {
  for (const spec of KNOWN_QUEUES) await ensureQueue(boss, spec);
  return KNOWN_QUEUES.length;
}

export function queueSpec(name: string): QueueSpec {
  const spec = KNOWN_QUEUES.find((q) => q.name === name);
  if (!spec) throw new Error(`unknown queue: ${name}`);
  return spec;
}
