// Typed database client: one node-postgres pool per process, wrapped by Drizzle (ADR 0002).
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

/** Pool size per process (ADR 0002 / architecture decision 6). */
export const POOL_MAX = 10;

/** The compose Postgres from `compose.yaml`; the same value as DATABASE_URL in `.env.example`. */
export const LOCAL_DATABASE_URL = "postgres://cleared:cleared@localhost:5432/cleared";

export type Db = NodePgDatabase & { $client: pg.Pool };

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: POOL_MAX });
  // An idle client dropped by the server (Postgres restart, failover) emits `error` on the pool; with no
  // listener that would crash the process. The pool discards the client and the next query reconnects,
  // so `/healthz` stays up and `/readyz` reports `db:false` instead (M1-08).
  pool.on("error", (error: Error) => {
    console.error(
      JSON.stringify({ service: "db", level: "warn", msg: "idle client error", error: error.message }),
    );
  });
  return drizzle({ client: pool });
}

/** Ends the pool behind a client created by `createDb`. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

/**
 * DATABASE_URL from the environment. Outside production it falls back to the local compose
 * database, so `make migrate` and the tests work without any env file; production must set it.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env["DATABASE_URL"];
  if (url) return url;
  if (env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  return LOCAL_DATABASE_URL;
}
