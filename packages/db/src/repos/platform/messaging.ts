// Outbox rows, consumer receipts and worker heartbeats: plain data access. Emit/consume logic is M1-03;
// readiness is M1-08.
import { asc, desc, eq, inArray, isNull, type InferSelectModel } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { consumerReceipts, outbox, workerHeartbeats } from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";

export type OutboxRow = InferSelectModel<typeof outbox>;
export type WorkerHeartbeatRow = InferSelectModel<typeof workerHeartbeats>;

export function outboxRepo(db: Db) {
  return {
    /** Pass the state change's `tx` so the row commits with it. */
    async append(
      row: { topic: string; version: number; payload: unknown },
      tx?: Executor,
    ): Promise<OutboxRow> {
      const rows = await (tx ?? db).insert(outbox).values(row).returning();
      const inserted = rows[0];
      if (!inserted) throw new Error("outbox insert returned no row");
      return inserted;
    },
    /** Oldest unpublished first. */
    listUnpublished(limit = 100, tx?: Executor): Promise<OutboxRow[]> {
      return (tx ?? db)
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(asc(outbox.createdAt))
        .limit(limit);
    },
    async markPublished(ids: readonly string[], at: Date, tx?: Executor): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await (tx ?? db)
        .update(outbox)
        .set({ publishedAt: at })
        .where(inArray(outbox.id, [...ids]))
        .returning({ id: outbox.id });
      return rows.length;
    },
  };
}

export function consumerReceiptsRepo(db: Db) {
  return {
    /** `true` the first time (consumer, message) is seen; `false` on a duplicate delivery. */
    async record(consumer: string, messageId: string, tx?: Executor): Promise<boolean> {
      const rows = await (tx ?? db)
        .insert(consumerReceipts)
        .values({ consumer, messageId })
        .onConflictDoNothing()
        .returning({ messageId: consumerReceipts.messageId });
      return rows.length === 1;
    },
  };
}

export function workerHeartbeatsRepo(db: Db) {
  return {
    async beat(workerId: string, at: Date, tx?: Executor): Promise<void> {
      await (tx ?? db)
        .insert(workerHeartbeats)
        .values({ workerId, beatAt: at })
        .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { beatAt: at } });
    },
    async latest(tx?: Executor): Promise<WorkerHeartbeatRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.beatAt))
        .limit(1);
      return rows[0] ?? null;
    },
    async get(workerId: string, tx?: Executor): Promise<WorkerHeartbeatRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, workerId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
