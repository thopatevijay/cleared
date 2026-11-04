// Runs a block as Render's app role, inside one transaction that is always rolled back. On Render the app
// connects as a non-superuser that OWNS the tables (it ran the migrations), with migration 0006's revokes
// on audit_log (no UPDATE / DELETE / TRUNCATE) and EXECUTE on purge_workspace (0019). Locally the compose user
// is a superuser, which passes every privilege check, so a purge test that never leaves that role can't see
// a production refusal (M4-06: "permission denied for table audit_log", 2026-11-03).
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../src/client.ts";
import { withTransaction, type Tx } from "../src/tx.ts";

class Rollback extends Error {}

export async function asRenderAppRole<T>(db: Db, block: (tx: Tx) => Promise<T>): Promise<T> {
  const role = `cleared_render_probe_${randomBytes(4).toString("hex")}`;
  let out: { value: T } | undefined;
  try {
    await withTransaction(db, async (tx) => {
      await tx.execute(sql.raw(`create role ${role} nosuperuser nologin`));
      const tables = await tx.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
      for (const r of tables.rows as { tablename: string }[]) {
        // ALTER OWNER hands the old owner's privileges, with 0006's revokes on audit_log, to the new owner
        await tx.execute(sql.raw(`alter table "${r.tablename}" owner to ${role}`));
      }
      await tx.execute(sql.raw(`grant execute on function purge_workspace(uuid) to ${role}`));
      await tx.execute(sql.raw(`set local role ${role}`));
      out = { value: await block(tx) };
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  if (out === undefined) throw new Error("asRenderAppRole: the block did not complete");
  return out.value;
}
