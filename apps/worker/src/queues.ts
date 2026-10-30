// Queue definitions and retry policy (ADR 0004, architecture §12). pg-boss 12 needs every queue created
// before `send`/`work`; jobs inherit the queue's retry, expiry and dead-letter settings at insert time.
import type { Queue } from "@cleared/db";

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
