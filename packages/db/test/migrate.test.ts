import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { runMigrations } from "../src/migrate.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

describe.skipIf(!dbAvailable)("migrations (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  afterAll(() => closeDb(db));

  it("applies the baseline once; a re-run is a no-op", async () => {
    await runMigrations(db);
    await runMigrations(db);
    const { rows } = await db.$client.query<{ n: string }>(
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("enables pgcrypto and creates no domain tables", async () => {
    const ext = await db.$client.query("select 1 from pg_extension where extname = 'pgcrypto'");
    expect(ext.rowCount).toBe(1);
    const tables = await db.$client.query("select 1 from information_schema.tables where table_schema = 'public'");
    expect(tables.rowCount).toBe(0);
  });
});
