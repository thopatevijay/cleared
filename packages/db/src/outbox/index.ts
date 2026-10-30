// The outbox API (M1-03). `createPublisher(db, boss, correlation)` binds the queue and the correlation
// source once; callers then use `emit(tx, event)` and `enqueue(tx, queue, data, opts)` inside their
// `withTransaction`, so the state change, the outbox row and the job commit or roll back together.
import type { DomainEvent } from "@cleared/core";
import { randomUUID } from "node:crypto";
import type { Db } from "../client.ts";
import type { Queue } from "../queue.ts";
import type { OutboxRow } from "../repos/platform/messaging.ts";
import type { Tx } from "../tx.ts";
import { emit } from "./emit.ts";
import { enqueue, type EnqueueOptions, type Enqueued } from "./enqueue.ts";
import type { CorrelationSource } from "./envelope.ts";

export interface Publisher {
  emit(tx: Tx, event: DomainEvent): Promise<OutboxRow>;
  enqueue<T>(tx: Tx, queue: string, data: T, opts?: EnqueueOptions): Promise<Enqueued<T>>;
}

export function createPublisher(db: Db, boss: Queue, correlation: CorrelationSource = randomUUID): Publisher {
  return {
    emit: (tx, event) => emit(db, boss, correlation, tx, event),
    enqueue: (tx, queue, data, opts) => enqueue(boss, correlation, tx, queue, data, opts),
  };
}

export { sendEnvelope, buildEnvelope, type EnqueueOptions, type Enqueued } from "./enqueue.ts";
export { EnvelopeSchema, parseEnvelope, type CorrelationSource, type Envelope } from "./envelope.ts";
export {
  RELAY_AFTER_MS,
  RELAY_CRON,
  RELAY_QUEUE,
  relayOutbox,
  type RelayDeps,
  type RelayFailure,
  type RelayResult,
} from "./relay.ts";
