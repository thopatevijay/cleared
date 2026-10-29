// Forward-only migrations with drizzle-orm's migrator (ADR 0002). Run by `make migrate`, and on deploy later (M0-08).
// Usage: `pnpm --filter @cleared/db run migrate` (reads DATABASE_URL; see `databaseUrl`).
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, createDb, databaseUrl, type Db } from "./client.ts";

/** `packages/db/migrations`: SQL files plus drizzle-kit's `meta/_journal.json`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies every pending migration; already-applied ones are skipped, so a re-run is a no-op. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    await runMigrations(db);
    const { rows } = await db.$client.query<{ n: string }>(
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    console.log(JSON.stringify({ service: "db", msg: "migrations applied", applied: Number(rows[0]?.n ?? 0) }));
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
