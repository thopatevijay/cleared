// pg-boss 12 on the same Postgres as the app, in its own schema (ADR 0004).
// Transactional enqueue: pass `{ db: jobDb(tx) }` to `boss.send` inside `db.transaction`, so the job
// commits or rolls back with the state change.
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { Db } from "./client.ts";

export const QUEUE_SCHEMA = "pgboss";

/** pg-boss keeps its own small pool (LISTEN/NOTIFY and transactional workers need one it owns). */
export const QUEUE_POOL_MAX = 4;

export type Queue = PgBoss;

type DrizzleTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function connectionStringOf(db: Db): string {
  const connectionString = db.$client.options.connectionString;
  if (!connectionString) throw new Error("queue: the db pool has no connectionString");
  return connectionString;
}

/** Starts pg-boss on the database behind `db` (creating or migrating its schema) and returns it. */
export async function createQueue(db: Db): Promise<Queue> {
  const boss = new PgBoss({
    connectionString: connectionStringOf(db),
    schema: QUEUE_SCHEMA,
    max: QUEUE_POOL_MAX,
  });
  boss.on("error", (error: unknown) => {
    console.error(JSON.stringify({ service: "queue", msg: "pg-boss error", error: String(error) }));
  });
  await boss.start();
  return boss;
}

/**
 * Creates or migrates the pg-boss schema without running any worker, supervisor or scheduler.
 * Part of `migrate`, so the schema exists right after `make up` and on deploy.
 */
export async function installQueueSchema(db: Db): Promise<void> {
  const boss = new PgBoss({
    connectionString: connectionStringOf(db),
    schema: QUEUE_SCHEMA,
    max: 1,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.stop({ graceful: false });
}

/** Wraps a Drizzle transaction so pg-boss writes the job inside it. */
export function jobDb(tx: DrizzleTx): ReturnType<typeof fromDrizzle> {
  return fromDrizzle(tx, sql);
}
