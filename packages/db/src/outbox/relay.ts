// Outbox relay safety net (ADR 0004, M1-03). Every minute the worker re-sends the job of each outbox
// row that is still unpublished 2 minutes after it was written (a job lost to manual DB surgery). The
// job id is the row id, so a job that still exists makes the send a no-op: one job per row, ever.
import { DomainEventSchema } from "@cleared/core";
import type { Db } from "../client.ts";
import type { Queue } from "../queue.ts";
import { outboxRepo } from "../repos/platform/messaging.ts";
import { withTransaction } from "../tx.ts";
import { buildEnvelope } from "./enqueue.ts";
import { sendOutboxRow } from "./emit.ts";
import type { CorrelationSource } from "./envelope.ts";

export const RELAY_QUEUE = "outbox.relay";
export const RELAY_CRON = "* * * * *";
export const RELAY_AFTER_MS = 2 * 60_000;

export interface RelayDeps {
  readonly db: Db;
  readonly boss: Queue;
  readonly correlation: CorrelationSource;
  /** Injected clock (tests move it); wall clock in the worker. */
  readonly now: () => Date;
  readonly limit?: number;
}

export interface RelayResult {
  /** Unpublished rows older than the cutoff. */
  readonly stale: number;
  /** Jobs actually created (a still-existing job is not doubled). */
  readonly enqueued: number;
  readonly failed: readonly RelayFailure[];
}

export interface RelayFailure {
  readonly outboxId: string;
  readonly topic: string;
  readonly error: string;
}

export async function relayOutbox(deps: RelayDeps): Promise<RelayResult> {
  const cutoff = new Date(deps.now().getTime() - RELAY_AFTER_MS);
  const rows = await outboxRepo(deps.db).listUnpublishedBefore(cutoff, deps.limit ?? 100);
  let enqueued = 0;
  const failed: RelayFailure[] = [];
  for (const row of rows) {
    const event = DomainEventSchema.safeParse(row.payload);
    const envelope = buildEnvelope(row.payload, deps.correlation, {
      messageId: row.id,
      ...(event.success ? { workspaceId: event.data.workspaceId } : {}),
    });
    try {
      const jobId = await withTransaction(deps.db, (tx) => sendOutboxRow(deps.boss, tx, row, envelope));
      if (jobId !== null) enqueued += 1;
    } catch (error) {
      // One bad row (e.g. a topic with no queue) must not stall the rows behind it.
      failed.push({ outboxId: row.id, topic: row.topic, error: String(error) });
    }
  }
  return { stale: rows.length, enqueued, failed };
}
