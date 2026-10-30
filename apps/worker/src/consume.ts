// Idempotent consumer (ADR 0004, M1-03). Each delivery runs in one Drizzle transaction that records
// `consumer_receipts(consumer, messageId)`, sets the outbox row's `published_at` the first time, and
// runs the handler. A redelivered message hits the receipt and acks `{ skipped: "duplicate" }`; a
// throwing handler rolls all of it back, so pg-boss retries it (and dead-letters it after the limit).
import { withContext, type Logger } from "@cleared/adapters";
import {
  parseEnvelope,
  platform,
  withTransaction,
  type Db,
  type Envelope,
  type JobWithMetadata,
  type Tx,
} from "@cleared/db";

export interface ConsumeContext {
  /** The delivery's transaction: write the handler's effects through it. */
  readonly tx: Tx;
  readonly envelope: Envelope;
  /** Carries the envelope's correlationId on every line. */
  readonly log: Logger;
  /** pg-boss metadata of this attempt (`retryCount`, `startAfter`, `startedOn`, …). */
  readonly job: JobWithMetadata<unknown>;
}

/** `data` is untrusted until the handler parses it with its own schema. */
export type Handler = (data: unknown, ctx: ConsumeContext) => Promise<void>;

export type ConsumeOutcome = { readonly consumed: true } | { readonly skipped: "duplicate" };

export interface ConsumeDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => Date;
}

const DUPLICATE: ConsumeOutcome = { skipped: "duplicate" };
const CONSUMED: ConsumeOutcome = { consumed: true };

export async function consumeOne(
  deps: ConsumeDeps,
  consumer: string,
  handler: Handler,
  job: JobWithMetadata<unknown>,
): Promise<ConsumeOutcome> {
  const envelope = parseEnvelope(job.data);
  const ctx = {
    correlationId: envelope.correlationId,
    messageId: envelope.messageId,
    ...(envelope.workspaceId === undefined ? {} : { workspaceId: envelope.workspaceId }),
  };
  return withContext(ctx, async () => {
    const meta = { queue: consumer, jobId: job.id, attempt: job.retryCount + 1 };
    const repos = platform(deps.db);
    try {
      const outcome = await withTransaction(deps.db, async (tx) => {
        if (!(await repos.consumerReceipts.record(consumer, envelope.messageId, tx))) return DUPLICATE;
        await repos.outbox.markConsumed(envelope.messageId, deps.now(), tx);
        await handler(envelope.data, { tx, envelope, log: deps.log, job });
        return CONSUMED;
      });
      deps.log.info(meta, "skipped" in outcome ? "message skipped: duplicate" : "message consumed");
      return outcome;
    } catch (error) {
      deps.log.warn({ ...meta, error: String(error) }, "message failed");
      throw error;
    }
  });
}

/** A pg-boss handler for `batchSize: 1` (the default); the outcome is stored as the job's output. */
export function consume(
  deps: ConsumeDeps,
  consumer: string,
  handler: Handler,
): (jobs: JobWithMetadata<unknown>[]) => Promise<ConsumeOutcome> {
  return (jobs) => {
    const [job, ...rest] = jobs;
    if (!job || rest.length > 0) throw new Error(`consume(${consumer}): expects batchSize 1`);
    return consumeOne(deps, consumer, handler, job);
  };
}
