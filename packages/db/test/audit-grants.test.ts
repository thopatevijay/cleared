// M2-08 AC: `UPDATE audit_log` / `DELETE FROM audit_log` as the app role fail. Two layers:
// - grants (migration 0006): the app role (the table owner on Render) holds no UPDATE/DELETE/TRUNCATE;
// - the 0002 trigger, which also stops a superuser (local and CI connect as one).
// The grant layer is proven on its own by running as a non-superuser owner inside a rolled-back
// transaction, where the trigger cannot be what refuses (privileges are checked before triggers fire).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

describe.skipIf(!dbAvailable)("audit_log grants (M2-08)", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(() => client.connect());
  afterAll(() => client.end());

  const privileges = async (grantee: "app" | "public"): Promise<string[]> => {
    const r = await client.query<{ privilege_type: string }>(
      `select a.privilege_type from pg_class c, aclexplode(c.relacl) a
        where c.relname = 'audit_log' and c.relkind = 'r'
          and a.grantee = ${grantee === "app" ? "(select oid from pg_roles where rolname = current_user)" : "0"}
        order by 1`,
    );
    return r.rows.map((x) => x.privilege_type);
  };

  it("the app role keeps INSERT and SELECT, and holds no UPDATE, DELETE or TRUNCATE; PUBLIC holds none", async () => {
    const app = await privileges("app");
    expect(app).toEqual(expect.arrayContaining(["INSERT", "SELECT"]));
    for (const p of ["UPDATE", "DELETE", "TRUNCATE"]) expect(app).not.toContain(p);
    expect(await privileges("public")).toEqual([]);
  });

  it.each([
    ["UPDATE audit_log", "update audit_log set action = 'x'"],
    ["DELETE FROM audit_log", "delete from audit_log"],
  ])("%s as the app role fails", async (_label, statement) => {
    await expect(client.query(statement)).rejects.toThrow(/permission denied for table audit_log|append-only/);
  });

  it("as a non-superuser owner the grants alone refuse UPDATE and DELETE (rolled back)", async () => {
    const su = await client.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname = current_user");
    if (su.rows[0]?.rolsuper !== true) {
      // Already a non-superuser (Render's shape): the statement above failed on the grants.
      await expect(client.query("delete from audit_log")).rejects.toThrow(/permission denied/);
      return;
    }
    const failsWith = async (statement: string): Promise<string> => {
      await client.query("begin");
      try {
        await client.query("create role cleared_audit_probe nosuperuser nologin");
        // ALTER OWNER hands the old owner's (revoked) privileges to the new owner.
        await client.query("alter table audit_log owner to cleared_audit_probe");
        await client.query("set local role cleared_audit_probe");
        await client.query(statement);
        return "succeeded";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await client.query("rollback");
      }
    };
    expect(await failsWith("update audit_log set action = 'x'")).toBe("permission denied for table audit_log");
    expect(await failsWith("delete from audit_log")).toBe("permission denied for table audit_log");
    expect(await failsWith("insert into audit_log (actor, action) values ('system', 'audit.probe')")).toBe(
      "succeeded",
    );
  });
});
