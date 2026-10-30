// Transactional enqueue (ADR 0004, M1-03): the pg-boss job is written through the caller's Drizzle
// transaction, so it commits or rolls back with the state change. For commands that are not domain
// events (e.g. `paypal.capture.sync`); domain events go through `emit`.
import { randomUUID } from "node:crypto";
import { jobDb, type Queue } from "../queue.ts";
import type { Tx } from "../tx.ts";
import { EnvelopeSchema, type CorrelationSource, type Envelope } from "./envelope.ts";

export interface EnqueueOptions {
  /** Idempotency key for consumers; a new uuid by default. */
  readonly messageId?: string;
  readonly workspaceId?: string;
  /** Overrides the correlation source (the current request's id by default). */
  readonly correlationId?: string;
  /** pg-boss job id; a second send with the same id in the same queue is a no-op. */
  readonly jobId?: string;
  readonly singletonKey?: string;
  readonly startAfter?: Date | number;
}

export interface Enqueued<T> {
  readonly envelope: Envelope<T>;
  /** null when a job with `jobId` already exists in the queue. */
  readonly jobId: string | null;
}

/** Writes `envelope` as a job on `queue` inside `tx` (the queue must exist: the worker creates it). */
export async function sendEnvelope(
  boss: Queue,
  tx: Tx,
  queue: string,
  envelope: Envelope,
  opts: Pick<EnqueueOptions, "jobId" | "singletonKey" | "startAfter"> = {},
): Promise<string | null> {
  EnvelopeSchema.parse(envelope);
  return boss.send(queue, envelope, {
    db: jobDb(tx),
    ...(opts.jobId === undefined ? {} : { id: opts.jobId }),
    ...(opts.singletonKey === undefined ? {} : { singletonKey: opts.singletonKey }),
    ...(opts.startAfter === undefined ? {} : { startAfter: opts.startAfter }),
  });
}

export function buildEnvelope<T>(
  data: T,
  correlation: CorrelationSource,
  opts: Pick<EnqueueOptions, "messageId" | "workspaceId" | "correlationId">,
): Envelope<T> {
  return {
    messageId: opts.messageId ?? randomUUID(),
    correlationId: opts.correlationId ?? correlation(),
    ...(opts.workspaceId === undefined ? {} : { workspaceId: opts.workspaceId }),
    data,
  };
}

export async function enqueue<T>(
  boss: Queue,
  correlation: CorrelationSource,
  tx: Tx,
  queue: string,
  data: T,
  opts: EnqueueOptions = {},
): Promise<Enqueued<T>> {
  const envelope = buildEnvelope(data, correlation, opts);
  const jobId = await sendEnvelope(boss, tx, queue, envelope, opts);
  return { envelope, jobId };
}
