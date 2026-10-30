// Forward-only migrations with drizzle-orm's migrator (ADR 0002), then the pg-boss schema (ADR 0004).
// Run by `make migrate`, and on deploy later (M0-08).
// Usage: `pnpm --filter @cleared/db run migrate` (reads DATABASE_URL; see `databaseUrl`).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, createDb, databaseUrl, type Db } from "./client.ts";
import { installQueueSchema, QUEUE_SCHEMA } from "./queue.ts";

/**
 * `packages/db/migrations`: SQL files plus drizzle-kit's `meta/_journal.json`. Built with `path.join`,
 * not `new URL("../migrations", import.meta.url)`: Next's bundler treats that form as an asset import
 * and fails the web build on a directory (M1-05).
 */
export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies every pending migration; already-applied ones are skipped, so a re-run is a no-op. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    await runMigrations(db);
    await installQueueSchema(db);
    const { rows } = await db.$client.query<{ n: string }>(
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    console.log(
      JSON.stringify({
        service: "db",
        msg: "migrations applied",
        applied: Number(rows[0]?.n ?? 0),
        queueSchema: QUEUE_SCHEMA,
      }),
    );
  } finally {
    await closeDb(db);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
