// pg-boss 12 on the same Postgres as the app, in its own schema (ADR 0004).
// Transactional enqueue: pass `{ db: jobDb(tx) }` to `boss.send` inside `db.transaction`, so the job
// commits or rolls back with the state change.
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { Db } from "./client.ts";
import { ensureKnownQueues } from "./queue-policy.ts";

export const QUEUE_SCHEMA = "pgboss";

/** pg-boss keeps its own small pool (LISTEN/NOTIFY and transactional workers need one it owns). */
export const QUEUE_POOL_MAX = 4;

export type Queue = PgBoss;
export type { Job, JobWithMetadata } from "pg-boss";

type DrizzleTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function connectionStringOf(db: Db): string {
  const connectionString = db.$client.options.connectionString;
  if (!connectionString) throw new Error("queue: the db pool has no connectionString");
  return connectionString;
}

export interface CreateQueueOptions {
  /**
   * `false` for a send-only producer (the web app): no supervisor, scheduler or maintenance, just a
   * small pool for `send`. Default true (the worker).
   */
  readonly background?: boolean;
  readonly max?: number;
}

/** Starts pg-boss on the database behind `db` (creating or migrating its schema) and returns it. */
export async function createQueue(db: Db, opts: CreateQueueOptions = {}): Promise<Queue> {
  const background = opts.background ?? true;
  const boss = new PgBoss({
    connectionString: connectionStringOf(db),
    schema: QUEUE_SCHEMA,
    max: opts.max ?? QUEUE_POOL_MAX,
    // M5-PERF: the worker LISTENs, so a notify-enabled queue's consumers wake on a new job instead of
    // polling every 2 s. A producer needs no listener: its insert emits the NOTIFY.
    ...(background ? { useListenNotify: true } : { supervise: false, schedule: false, migrate: false }),
  });
  boss.on("error", (error: unknown) => {
    console.error(JSON.stringify({ service: "queue", msg: "pg-boss error", error: String(error) }));
  });
  await boss.start();
  return boss;
}

/**
 * Creates or migrates the pg-boss schema and every known queue (M1-04, BL-01 6528386693) without
 * running any worker, supervisor or scheduler. Part of `migrate`, so the schema and queues exist right
 * after `make up` and on deploy. Returns the number of known queues ensured.
 */
export async function installQueueSchema(db: Db): Promise<number> {
  const boss = new PgBoss({
    connectionString: connectionStringOf(db),
    schema: QUEUE_SCHEMA,
    max: 1,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  try {
    return await ensureKnownQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/** Wraps a Drizzle transaction so pg-boss writes the job inside it. */
export function jobDb(tx: DrizzleTx): ReturnType<typeof fromDrizzle> {
  return fromDrizzle(tx, sql);
}
