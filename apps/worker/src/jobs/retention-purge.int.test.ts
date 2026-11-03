// M4-07 retention purge on a seeded database with a fake clock at 2026-12-22T00:01Z:
// - the purge empties every listed table for the expired demo workspaces, leaves the seller, the pool and
//   the not-yet-due demo workspace untouched, and writes one counts-only platform audit row per workspace;
// - a second run purges 0; `--dry-run` changes nothing;
// - the app role still can't `DELETE FROM audit_log`, and `purge_workspace` refuses a seller or pool workspace;
// - a capture/dispute sync that races the purge sees it and writes nothing (`acceptsMirror`).
// Every run is limited to this file's workspaces (`workspaceIds`), so other files' demo workspaces stay.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLogger } from "@cleared/adapters";
import {
  closeDb,
  createDb,
  platform,
  PURGE_TABLES,
  RETENTION_PURGED_ACTION,
  withTransaction,
} from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbAvailable, url } from "../../test/helpers.ts";
import { createWorkspace, rowCounts, seedEveryTable } from "../../test/retention-support.ts";
import { formatReport, parseArgs, runRetentionPurge, type RetentionPurgeDeps } from "./retention-purge.ts";

const db = createDb(url);
const log = createLogger({ service: "worker-test", level: "silent" });
const FAKE_NOW = new Date("2026-12-22T00:01:00Z");
const ws = { expiredA: "", expiredB: "", notDue: "", seller: "", pool: "" };
const ids = (): string[] => Object.values(ws);

function deps(over: Partial<RetentionPurgeDeps> = {}): RetentionPurgeDeps {
  return { db, log, now: () => FAKE_NOW, workspaceIds: ids(), ...over };
}

async function auditRows(workspaceId: string) {
  const r = await db.$client.query<{
    workspace_id: string | null;
    actor: string;
    detail: Record<string, unknown>;
  }>(`select workspace_id, actor, detail from audit_log where action = $1 and detail->>'workspaceId' = $2`, [
    RETENTION_PURGED_ACTION,
    workspaceId,
  ]);
  return r.rows;
}

afterAll(() => closeDb(db));

const allCounts = async () =>
  Object.fromEntries(await Promise.all(ids().map(async (id) => [id, await rowCounts(db, id)] as const)));

describe.skipIf(!dbAvailable)("retention purge (M4-07)", () => {
  beforeAll(async () => {
    ws.expiredA = await createWorkspace(db, {
      kind: "demo",
      createdAt: "2026-11-20T10:00:00Z",
      expiresAt: "2026-12-16T00:00:00Z",
    });
    ws.expiredB = await createWorkspace(db, {
      kind: "demo",
      createdAt: "2026-11-25T10:00:00Z",
      expiresAt: "2026-12-16T00:00:00Z",
    });
    ws.notDue = await createWorkspace(db, {
      kind: "demo",
      createdAt: "2026-12-20T00:00:00Z",
      expiresAt: "2026-12-27T00:00:00Z",
    });
    ws.seller = await createWorkspace(db, {
      kind: "seller",
      createdAt: "2026-11-01T00:00:00Z",
      expiresAt: null,
    });
    ws.pool = await createWorkspace(db, {
      kind: "seller",
      createdAt: "2026-11-01T00:00:00Z",
      expiresAt: null,
    });
    for (const id of [ws.expiredA, ws.expiredB, ws.notDue, ws.seller]) await seedEveryTable(db, id);
    // a judge-pool review hold assigned to the expired workspace (ADR 0019)
    await db.$client.query(
      `insert into review_hold_pool (order_id, pool_workspace_id, purpose, state, amount, currency, approve_url,
         assigned_workspace_id, assigned_at)
       values ('RET-ORD-' || gen_random_uuid(), $1, 'judge', 'held', 10, 'USD', 'https://example.test', $2, now())`,
      [ws.pool, ws.expiredA],
    );
  });
  it("every listed table has a row for each seeded workspace", async () => {
    const counts = await allCounts();
    for (const id of [ws.expiredA, ws.expiredB, ws.notDue, ws.seller]) {
      for (const t of PURGE_TABLES) expect({ id, t, n: counts[id]?.[t] }).toEqual({ id, t, n: 1 });
    }
  });

  it("--dry-run reports the due workspaces and changes nothing (row counts equal before and after)", async () => {
    const before = await allCounts();
    const r = await runRetentionPurge(deps({ dryRun: true }));
    expect(r).toMatchObject({ dryRun: true, failed: [], rows: 2 * PURGE_TABLES.length + 1 });
    expect(r.purged.map((p) => p.workspaceId).sort()).toEqual([ws.expiredA, ws.expiredB].sort());
    expect(r.purged.find((p) => p.workspaceId === ws.expiredA)?.counts.review_hold_pool_detached).toBe(1);
    expect(await allCounts()).toEqual(before);
    expect(await auditRows(ws.expiredA)).toEqual([]);
    expect(formatReport(r)).toContain("dry run: nothing changed");
  });

  it("purges every row of the expired demo workspaces and leaves the seller, pool and not-due ones", async () => {
    const before = await allCounts();
    const r = await runRetentionPurge(deps());
    expect(r.failed).toEqual([]);
    expect(r.purged.map((p) => p.workspaceId).sort()).toEqual([ws.expiredA, ws.expiredB].sort());
    const after = await allCounts();
    for (const id of [ws.expiredA, ws.expiredB]) {
      expect(Object.values(after[id] ?? {}).every((n) => n === 0)).toBe(true);
      const w = await platform(db).workspaces.get(id);
      expect(w?.purgedAt).toBeInstanceOf(Date);
    }
    for (const id of [ws.notDue, ws.seller, ws.pool]) expect(after[id]).toEqual(before[id]);
    const pool = await db.$client.query(
      "select assigned_workspace_id from review_hold_pool where pool_workspace_id = $1",
      [ws.pool],
    );
    expect(pool.rows).toEqual([{ assigned_workspace_id: null }]);
  });

  it("writes one platform-level, counts-only audit row per purged workspace", async () => {
    for (const id of [ws.expiredA, ws.expiredB]) {
      const rows = await auditRows(id);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.workspace_id).toBeNull();
      expect(row?.actor).toBe("system");
      expect(Object.keys(row?.detail ?? {}).sort()).toEqual(["counts", "workspaceId"]);
      const counts = row?.detail["counts"] as Record<string, unknown>;
      expect(Object.values(counts).every((n) => typeof n === "number")).toBe(true);
      expect(counts["audit_log"]).toBe(1);
    }
    expect(await auditRows(ws.notDue)).toEqual([]);
    expect(await auditRows(ws.seller)).toEqual([]);
  });

  it("a second run purges 0 and writes no second audit row (idempotent)", async () => {
    const before = await allCounts();
    const r = await runRetentionPurge(deps());
    expect(r).toMatchObject({ purged: [], failed: [], rows: 0 });
    expect(await allCounts()).toEqual(before);
    expect(await auditRows(ws.expiredA)).toHaveLength(1);
  });

  it("a late PayPal sync can't write into a purged workspace; a not-due one still takes rows", async () => {
    const accepts = (id: string) =>
      withTransaction(db, (tx) => platform(db).workspaces.acceptsMirror(id, FAKE_NOW, tx));
    expect(await accepts(ws.expiredA)).toBe(false);
    expect(await accepts(ws.notDue)).toBe(true);
    expect(await accepts(ws.seller)).toBe(true);
  });

  it("a sync racing the purge waits for it and then refuses (the workspace row lock)", async () => {
    const racing = await createWorkspace(db, {
      kind: "demo",
      createdAt: "2026-11-21T00:00:00Z",
      expiresAt: "2026-12-16T00:00:00Z",
    });
    const purger = await db.$client.connect();
    try {
      await purger.query("begin");
      await purger.query("select purge_workspace($1)", [racing]);
      let settled = false;
      const sync = withTransaction(db, (tx) =>
        platform(db).workspaces.acceptsMirror(racing, FAKE_NOW, tx),
      ).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the purge's row lock
      await purger.query("commit");
      expect(await sync).toBe(false);
    } finally {
      purger.release();
    }
  });

  it("purge_workspace refuses a seller workspace and the review-hold pool workspace", async () => {
    await expect(db.$client.query("select purge_workspace($1)", [ws.seller])).rejects.toThrow(
      /is a seller workspace/,
    );
    await expect(db.$client.query("select purge_workspace($1)", [ws.pool])).rejects.toThrow(
      /seller workspace|pool/,
    );
    expect(await rowCounts(db, ws.seller)).toEqual(Object.fromEntries(PURGE_TABLES.map((t) => [t, 1])));
  });

  it("one workspace's failure is reported and the rest still run", async () => {
    const spec = {
      kind: "demo",
      createdAt: "2026-11-22T00:00:00Z",
      expiresAt: "2026-12-16T00:00:00Z",
    } as const;
    const first = await createWorkspace(db, spec);
    const second = await createWorkspace(db, { ...spec, createdAt: "2026-11-23T00:00:00Z" });
    const alert = vi.fn();
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("connection lost"));
    try {
      const r = await runRetentionPurge(deps({ workspaceIds: [first, second], alert }));
      expect(r.failed).toEqual([first]);
      expect(r.purged.map((p) => p.workspaceId)).toEqual([second]);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]?.[1]).toMatchObject({ workspaceId: first, job: "retention.purge" });
    } finally {
      spy.mockRestore();
    }
    // the failed one is still a candidate: the next day's run picks it up
    const retry = await runRetentionPurge(deps({ workspaceIds: [first, second] }));
    expect(retry.purged.map((p) => p.workspaceId)).toEqual([first]);
  });
});

describe.skipIf(!dbAvailable)("audit_log stays append-only for the app role (M4-07 AC)", () => {
  const client = db.$client;

  it("DELETE FROM audit_log as the app role fails", async () => {
    await expect(client.query("delete from audit_log")).rejects.toThrow(
      /permission denied for table audit_log|append-only/,
    );
  });

  it("the app role holds EXECUTE on purge_workspace only; the function belongs to cleared_purger", async () => {
    const r = await client.query<{ owner: string; definer: boolean; app: boolean; pub: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
         has_function_privilege(current_user, p.oid, 'EXECUTE') as app,
         exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as pub
       from pg_proc p where p.proname = 'purge_workspace'`,
    );
    expect(r.rows).toEqual([{ owner: "cleared_purger", definer: true, app: true, pub: false }]);
    const login = await client.query<{ rolcanlogin: boolean }>(
      "select rolcanlogin from pg_roles where rolname = 'cleared_purger'",
    );
    expect(login.rows).toEqual([{ rolcanlogin: false }]);
  });

  it("as a non-superuser owner (Render's shape) the grants alone refuse DELETE (rolled back)", async () => {
    const conn = await client.connect();
    await conn.query("begin");
    let outcome = "succeeded";
    try {
      await conn.query("create role cleared_retention_probe nosuperuser nologin");
      // ALTER OWNER hands the old owner's (revoked, migration 0006) privileges to the new owner
      await conn.query("alter table audit_log owner to cleared_retention_probe");
      await conn.query("set local role cleared_retention_probe");
      await conn.query("delete from audit_log");
    } catch (e) {
      outcome = (e as Error).message;
    } finally {
      await conn.query("rollback");
      conn.release();
    }
    expect(outcome).toBe("permission denied for table audit_log");
  });
});

describe("retention purge CLI", () => {
  it("parses --dry-run, --workspace and FAKE_NOW; rejects anything else", () => {
    const a = parseArgs(["--dry-run", "--workspace", "w1"], { FAKE_NOW: "2026-12-22T00:01:00Z" });
    expect(a.dryRun).toBe(true);
    expect(a.workspaceIds).toEqual(["w1"]);
    expect(a.now().toISOString()).toBe("2026-12-22T00:01:00.000Z");
    expect(parseArgs([], {}).dryRun).toBe(false);
    expect(() => parseArgs(["--force"], {})).toThrow("unknown argument");
    expect(() => parseArgs([], { FAKE_NOW: "tomorrow" })).toThrow("FAKE_NOW");
  });

  it.skipIf(!dbAvailable)("--dry-run on one workspace prints its counts and exits 0", async () => {
    const cli = fileURLToPath(new URL("./retention-purge.ts", import.meta.url));
    const id = await createWorkspace(db, {
      kind: "demo",
      createdAt: "2026-11-20T00:00:00Z",
      expiresAt: "2026-12-16T00:00:00Z",
    });
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "--dry-run", "--workspace", id], {
      env: { ...process.env, FAKE_NOW: "2026-12-22T00:01:00Z" },
    });
    expect(stdout).toContain("retention purge (dry run: nothing changed) at 2026-12-22T00:01:00.000Z");
    expect(stdout).toContain(`${id}: 0 rows`);
  });
});
