// `emit(tx, event)` (ADR 0004, M1-03): the outbox row and its pg-boss job are written in the caller's
// transaction. The queue is the event type; the job id, its singletonKey and the envelope messageId
// are all the outbox row id, so the relay can never double a job and consumers dedupe on it.
import { DomainEventSchema, type DomainEvent } from "@cleared/core";
import type { Queue } from "../queue.ts";
import { outboxRepo, type OutboxRow } from "../repos/platform/messaging.ts";
import type { Tx } from "../tx.ts";
import type { Db } from "../client.ts";
import { buildEnvelope, sendEnvelope } from "./enqueue.ts";
import type { CorrelationSource, Envelope } from "./envelope.ts";

/** The job that carries an outbox row; shared by `emit` and the relay. */
export function sendOutboxRow(
  boss: Queue,
  tx: Tx,
  row: Pick<OutboxRow, "id" | "topic" | "payload">,
  envelope: Envelope,
): Promise<string | null> {
  return sendEnvelope(boss, tx, row.topic, envelope, { jobId: row.id, singletonKey: row.id });
}

export async function emit(
  db: Db,
  boss: Queue,
  correlation: CorrelationSource,
  tx: Tx,
  event: DomainEvent,
): Promise<OutboxRow> {
  const parsed = DomainEventSchema.parse(event);
  const row = await outboxRepo(db).append(
    { topic: parsed.type, version: parsed.version, payload: parsed },
    tx,
  );
  const envelope = buildEnvelope(parsed, correlation, {
    messageId: row.id,
    workspaceId: parsed.workspaceId,
  });
  await sendOutboxRow(boss, tx, row, envelope);
  return row;
}
