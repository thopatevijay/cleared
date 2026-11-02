// M3-09: the synthetic workspace purge removes every row of the workspace (append-only tables included) and
// restores the append-only guards; it refuses a non-synthetic workspace. Synthetic workspaces are left out
// of the demo caps. `ops_checks` reads its newest row per check.
import { WorkspaceIdSchema } from "@cleared/core";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { platform } from "../src/repos/platform/index.ts";
import { purgeSyntheticWorkspace } from "../src/repos/platform/ops.ts";
import { forWorkspace } from "../src/repos/workspace/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { seedGraph } from "./graph.ts";

const SCOPED = [
  "agent_runs",
  "agent_steps",
  "approvals",
  "audit_log",
  "blobs",
  "client_acks",
  "dispute_drafts",
  "disputes",
  "evidence_items",
  "executions",
  "explanations",
  "extracted_facts",
  "holds",
  "magic_links",
  "notifications",
  "payments",
  "paypal_resource_owner",
  "proof_packs",
  "proposed_actions",
  "scenario_runs",
  "scope_checks",
  "sessions",
  "users",
];

describe.skipIf(!dbAvailable)("ops (M3-09)", () => {
  const db = createDb(TEST_DATABASE_URL);
  afterAll(() => closeDb(db));

  const create = (synthetic: boolean) =>
    platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
      synthetic,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

  async function rowsOf(ws: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of SCOPED) {
      const r = await db.execute(
        sql`select count(*)::int as n from ${sql.identifier(t)} where workspace_id = ${ws}`,
      );
      out[t] = (r.rows[0] as { n: number }).n;
    }
    return out;
  }

  it("covers every table with a workspace_id", async () => {
    const r = await db.execute(
      sql`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id' order by 1`,
    );
    expect(r.rows.map((x) => (x as { t: string }).t)).toEqual([...SCOPED].sort());
  });

  it("purges every row of a synthetic workspace and restores the append-only guards", async () => {
    const ws = await create(true);
    await seedGraph(forWorkspace(db, WorkspaceIdSchema.parse(ws.id)));
    await platform(db).auth.auditSystem({ workspaceId: ws.id, action: "test.row", detail: {} });
    await platform(db).resourceOwners.claim({
      resourceType: "order",
      resourceId: `SYN${String(Date.now())}`,
      workspaceId: ws.id,
    });
    const before = await rowsOf(ws.id);
    expect(Object.values(before).every((n) => n > 0) ? true : before).toBe(true);
    const deleted = await withTransaction(db, (tx) => purgeSyntheticWorkspace(ws.id, tx));
    expect(deleted).toBeGreaterThan(SCOPED.length);
    expect(Object.values(await rowsOf(ws.id)).every((n) => n === 0)).toBe(true);
    expect(await platform(db).workspaces.get(ws.id)).toBeNull();
    // the triggers are back
    await expect(db.$client.query("delete from audit_log where false")).rejects.toThrow(/append-only/);
    await expect(db.$client.query("delete from evidence_items where false")).rejects.toThrow(/append-only/);
    await expect(db.$client.query("delete from scope_checks where false")).rejects.toThrow(/append-only/);
  });

  it("refuses a workspace that is not synthetic and changes nothing", async () => {
    const ws = await create(false);
    await platform(db).auth.auditSystem({ workspaceId: ws.id, action: "test.row", detail: {} });
    await expect(withTransaction(db, (tx) => purgeSyntheticWorkspace(ws.id, tx))).rejects.toThrow(
      /non-synthetic/,
    );
    expect((await rowsOf(ws.id))["audit_log"]).toBe(1);
  });

  it("leaves synthetic workspaces out of the demo caps", async () => {
    const now = new Date();
    const auth = platform(db).auth;
    const live = await auth.countLiveDemoWorkspaces(now);
    const recent = await auth.countDemoWorkspacesSince(new Date(now.getTime() - 60_000));
    await create(true);
    expect(await auth.countLiveDemoWorkspaces(now)).toBe(live);
    expect(await auth.countDemoWorkspacesSince(new Date(now.getTime() - 60_000))).toBe(recent);
  });

  it("ops_checks: the newest row per check, optionally passing only", async () => {
    const repo = platform(db).opsChecks;
    const check = `test.${String(Date.now())}`;
    await repo.insert([
      { check, value: 1, target: 2, pass: true, runAt: new Date("2026-11-01T00:00:00Z") },
      { check, value: 3, target: 2, pass: false, runAt: new Date("2026-11-02T00:00:00Z") },
    ]);
    expect(await repo.latest(check)).toMatchObject({ value: 3, pass: false });
    expect(await repo.latest(check, { pass: true })).toMatchObject({ value: 1, pass: true });
    expect(await repo.latest("test.none")).toBeNull();
  });
});
