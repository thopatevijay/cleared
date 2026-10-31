// AC: the migrations create every docs/architecture.md §5 table plus the M1 extensions; migrate and seed
// are no-ops the second time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { MIGRATIONS_FOLDER, runMigrations } from "../src/migrate.ts";
import { seed, SEED_USER_EMAIL, SEED_WORKSPACE_ID } from "../src/seed.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

/** §5, in its order, then the extensions (consumer_receipts: M1-03; worker_heartbeats: M1-08; platform_flags: M2-02; scenario_runs: M2-10). */
const EXPECTED_TABLES = [
  "workspaces",
  "users",
  "sessions",
  "magic_links",
  "paypal_resource_owner",
  "webhook_events",
  "payments",
  "proof_packs",
  "evidence_items",
  "blobs",
  "extracted_facts",
  "scope_checks",
  "client_acks",
  "holds",
  "explanations",
  "disputes",
  "dispute_drafts",
  "proposed_actions",
  "approvals",
  "executions",
  "audit_log",
  "agent_runs",
  "agent_steps",
  "outbox",
  "notifications",
  "idempotency_keys",
  "consumer_receipts",
  "worker_heartbeats",
  "platform_flags",
  "scenario_runs",
];

const EXTENSION_COLUMNS: Record<string, string[]> = {
  webhook_events: ["status", "processed_at", "correlation_id", "quarantine_reason"],
  workspaces: ["created_ip_hash", "llm_budget_usd"],
  sessions: ["workspace_id", "user_id", "kind", "token_hash", "expires_at", "last_seen_at"],
  agent_runs: ["prompt_version", "correlation_id", "output", "error"],
  agent_steps: ["kind", "detail", "correlation_id"],
};

const PLATFORM_TABLES = new Set([
  "webhook_events",
  "outbox",
  "idempotency_keys",
  "consumer_receipts",
  "worker_heartbeats",
  "platform_flags",
  "workspaces",
]);

const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
  entries: unknown[];
};

describe.skipIf(!dbAvailable)("migrations and seed (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  afterAll(() => closeDb(db));

  const q = async <R extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> =>
    (await db.$client.query<R>(text, params)).rows;

  it("creates exactly the §5 tables plus the M1 extensions", async () => {
    const rows = await q<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it.each(Object.entries(EXTENSION_COLUMNS))("%s has the M1 extension columns", async (table, columns) => {
    const rows = await q<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    expect(rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(columns));
  });

  it("every non-platform table carries workspace_id with an index on (workspace_id, created_at)", async () => {
    const scoped = EXPECTED_TABLES.filter((t) => !PLATFORM_TABLES.has(t));
    const indexes = await q<{ tablename: string; indexdef: string }>(
      "select tablename, indexdef from pg_indexes where schemaname = 'public'",
    );
    for (const table of scoped) {
      const defs = indexes.filter((i) => i.tablename === table).map((i) => i.indexdef);
      expect(
        defs.some((d) => d.includes("(workspace_id, created_at)")),
        table,
      ).toBe(true);
    }
  });

  it("every timestamp column is timestamptz", async () => {
    const rows = await q<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone'",
    );
    expect(rows).toEqual([]);
  });

  it("migrate and seed twice: the second run changes nothing", async () => {
    await runMigrations(db);
    await seed(db);
    const counts = async () =>
      q<{ migrations: string; workspaces: string; users: string }>(
        `select (select count(*) from drizzle.__drizzle_migrations) as migrations,
                (select count(*) from workspaces) as workspaces, (select count(*) from users) as users`,
      );
    const before = await counts();
    await runMigrations(db);
    expect(await seed(db)).toEqual({ workspaces: 0, users: 0 });
    expect(await counts()).toEqual(before);
    expect(Number(before[0]?.migrations)).toBe(journal.entries.length);
  });

  it("seeds one synthetic seller workspace and user, and no PayPal data", async () => {
    const [ws] = await q<{ kind: string; locale: string; timezone: string }>(
      "select kind, locale, timezone from workspaces where id = $1",
      [SEED_WORKSPACE_ID],
    );
    expect(ws).toEqual({ kind: "seller", locale: "hi", timezone: "Asia/Kolkata" });
    const users = await q("select 1 from users where workspace_id = $1 and email = $2", [
      SEED_WORKSPACE_ID,
      SEED_USER_EMAIL,
    ]);
    expect(users).toHaveLength(1);
    // "No PayPal data" is a property of what seed() writes, not of the shared database: a live proof
    // run in the seed workspace (M1-04 gate) legitimately adds payments there (BL-01 6530006070).
    // seed() issues its inserts on every run (ON CONFLICT DO NOTHING), so its SQL shows every table
    // it can write, whatever the database already holds.
    const statements: string[] = [];
    const logged = drizzle({ client: db.$client, logger: { logQuery: (sql) => statements.push(sql) } });
    await seed(logged);
    const written = statements
      .filter((s) => !/^\s*(begin|commit)\s*;?\s*$/i.test(s))
      .map((s) => /^\s*(?:insert into|update|delete from)\s+"(\w+)"/i.exec(s)?.[1]);
    expect(written.sort()).toEqual(["users", "workspaces"]);
  });

  it("keeps pgcrypto enabled", async () => {
    expect(await q("select 1 from pg_extension where extname = 'pgcrypto'")).toHaveLength(1);
  });
});
