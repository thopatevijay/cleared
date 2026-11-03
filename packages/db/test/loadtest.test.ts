// M4-06: the `loadtest` workspaces the seed CLI creates for the launch-load run, their count and their purge.
// They sit outside the demo caps, their resources are claimed (the reads join on the claim) but the reconcile
// poll never lists them (their ids aren't PayPal's), and the purge (M4-07's purge_workspace) empties every
// one of their rows, audit rows included, and nothing else. It also works as Render's app role.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import {
  countLoadtestWorkspaces,
  createLoadtestWorkspaces,
  purgeLoadtestWorkspaces,
} from "../src/loadtest.ts";
import { platform } from "../src/repos/platform/index.ts";
import { purgeSyntheticWorkspace } from "../src/repos/platform/ops.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";
import { asRenderAppRole } from "./render-shape.ts";

const n = async (db: ReturnType<typeof createDb>, q: ReturnType<typeof sql>): Promise<number> =>
  Number(((await db.execute(q)).rows[0] as { n: string | number }).n);

describe.skipIf(!dbAvailable)("loadtest workspaces (M4-06)", () => {
  const db = createDb(TEST_DATABASE_URL);
  afterAll(async () => {
    await purgeLoadtestWorkspaces(db);
    await closeDb(db);
  });

  it("creates N tagged synthetic workspaces with sessions and readable rows, outside the demo caps", async () => {
    await purgeLoadtestWorkspaces(db);
    const before = await platform(db).auth.countLiveDemoWorkspaces(new Date());
    const ws = await createLoadtestWorkspaces(db, 2);
    expect(ws).toHaveLength(2);
    expect(await countLoadtestWorkspaces(db)).toBe(2);
    expect(await platform(db).auth.countLiveDemoWorkspaces(new Date())).toBe(before);
    const w = ws[0];
    if (w === undefined) throw new Error("no workspace");
    expect(w.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await platform(db).identity.sessionByTokenHash(
      createHash("sha256").update(w.token).digest("hex"),
    );
    expect(session?.workspaceId).toBe(w.workspaceId);
    expect(w.paymentIds).toHaveLength(3);
    expect(w.packIds).toHaveLength(3);
    expect(w.holdIds).toHaveLength(2);
    expect(w.disputeIds).toHaveLength(1);
    expect(
      await n(db, sql`select count(*) as n from paypal_resource_owner where workspace_id = ${w.workspaceId}`),
    ).toBe(4);
    const targets = platform(db).reconcileTargets;
    const polled = [
      ...(await targets.captures(new Date(0))).map((c) => c.workspaceId),
      ...(await targets.disputes()).map((d) => d.workspaceId),
    ];
    expect(polled.filter((id) => ws.some((x) => x.workspaceId === id))).toEqual([]);
  });

  it("purges every loadtest row (audit rows included) through purge_workspace, and nothing else", async () => {
    const other = await n(
      db,
      sql`select count(*) as n from workspaces where created_ip_hash is distinct from 'loadtest'`,
    );
    const ws = await createLoadtestWorkspaces(db, 1);
    const id = ws[0]?.workspaceId ?? "";
    await platform(db).auth.auditSystem({ workspaceId: id, action: "test.loadtest", detail: {} });
    const r = await purgeLoadtestWorkspaces(db);
    expect(r.workspaces).toBeGreaterThanOrEqual(1);
    expect(await countLoadtestWorkspaces(db)).toBe(0);
    const tables = [
      "payments",
      "holds",
      "disputes",
      "proof_packs",
      "evidence_items",
      "sessions",
      "audit_log",
    ];
    for (const table of tables) {
      expect(
        await n(db, sql`select count(*) as n from ${sql.identifier(table)} where workspace_id = ${id}`),
      ).toBe(0);
    }
    // like a retention purge, the emptied workspace row stays, marked purged
    expect((await platform(db).workspaces.get(id))?.purgedAt).toBeInstanceOf(Date);
    expect(
      await n(
        db,
        sql`select count(*) as n from workspaces where created_ip_hash is distinct from 'loadtest'`,
      ),
    ).toBe(other);
  });

  it("as Render's app role: the purge_workspace path removes audit rows; deleting the workspace row is refused", async () => {
    const ws = await createLoadtestWorkspaces(db, 1);
    const id = ws[0]?.workspaceId ?? "";
    await platform(db).auth.auditSystem({ workspaceId: id, action: "test.loadtest", detail: {} });
    const out = await asRenderAppRole(db, async (tx) => {
      // what the first version did after emptying the rows: refused on Render (2026-11-03)
      await tx.execute(sql`savepoint old_way`);
      let refused = "";
      try {
        await purgeSyntheticWorkspace(id, tx);
        await tx.execute(sql`delete from workspaces where id = ${id}`);
      } catch (e) {
        refused = errorText(e);
      }
      await tx.execute(sql`rollback to savepoint old_way`);
      const counts = await platform(db).retention.purge(id, tx);
      const left = await tx.execute(sql`select count(*)::int as n from audit_log where workspace_id = ${id}`);
      return { refused, counts, left: (left.rows[0] as { n: number }).n };
    });
    expect(out.refused).toMatch(/permission denied for table audit_log/);
    expect(out.counts.audit_log).toBe(1);
    expect(out.counts.payments).toBe(3);
    expect(out.left).toBe(0);
  });
});

/** The Postgres message, wherever the driver wrapped it. */
function errorText(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
}
