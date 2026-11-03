// M4-06: the `loadtest` workspaces the seed CLI creates for the launch-load run, their count and their purge.
// They sit outside the demo caps, their resources are claimed (the reads join on the claim) but the reconcile
// poll never lists them (their ids aren't PayPal's), and the purge removes every row, the workspace included,
// and only theirs.
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { countLoadtestWorkspaces, createLoadtestWorkspaces, purgeLoadtestWorkspaces } from "../src/loadtest.ts";
import { platform } from "../src/repos/platform/index.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

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
    const session = await platform(db).identity.sessionByTokenHash(createHash("sha256").update(w.token).digest("hex"));
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

  it("purges every loadtest row and workspace, and nothing else", async () => {
    const other = await n(db, sql`select count(*) as n from workspaces where created_ip_hash is distinct from 'loadtest'`);
    const ws = await createLoadtestWorkspaces(db, 1);
    const id = ws[0]?.workspaceId ?? "";
    const r = await purgeLoadtestWorkspaces(db);
    expect(r.workspaces).toBeGreaterThanOrEqual(1);
    expect(await countLoadtestWorkspaces(db)).toBe(0);
    for (const table of ["payments", "holds", "disputes", "proof_packs", "evidence_items", "sessions"]) {
      expect(await n(db, sql`select count(*) as n from ${sql.identifier(table)} where workspace_id = ${id}`)).toBe(0);
    }
    expect(await n(db, sql`select count(*) as n from workspaces where created_ip_hash is distinct from 'loadtest'`)).toBe(
      other,
    );
  });
});
