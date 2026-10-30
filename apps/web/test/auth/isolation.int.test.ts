// M1-05 AC: a demo session for workspace A calling a scoped route with B's id in the query or body
// still reads (and changes) A only. The workspace id comes only from the session.
import { describe, expect, it } from "vitest";
import { postDemo } from "../../src/server/handlers/demo.ts";
import { getWorkspace, postSignOut } from "../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

describe.skipIf(!dbAvailable)("workspace isolation (integration)", () => {
  it("A's session with B's id in the query or body reads and signs out A only", async () => {
    const deps = testDeps();
    const a = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
    const b = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
    const read = async (cookie: string, query = "") =>
      getWorkspace(req(`/api/workspace${query}`, { method: "GET", cookie }), deps);
    const idOf = async (res: Response) => ((await res.json()) as { workspace: { id: string } }).workspace.id;

    const aId = await idOf(await read(a));
    const bId = await idOf(await read(b));
    expect(aId).not.toBe(bId);

    expect(await idOf(await read(a, `?workspaceId=${bId}&workspace_id=${bId}`))).toBe(aId);

    const out = await postSignOut(req("/api/auth/sign-out", { cookie: a, body: { workspaceId: bId } }), deps);
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-cleared_session=; Path=\/; Max-Age=0/);
    expect((await read(a)).status).toBe(401);
    expect(await idOf(await read(b))).toBe(bId);
  });

  it("no session → 401 in the ADR 0003 envelope", async () => {
    const res = await getWorkspace(req("/api/workspace", { method: "GET" }), testDeps());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(["code", "correlationId", "details", "message"]);
    expect(body.error["code"]).toBe("unauthenticated");
  });

  it("a forged cookie value → 401", async () => {
    const res = await getWorkspace(
      req("/api/workspace", { method: "GET", cookie: `__Host-cleared_session=${"x".repeat(43)}` }),
      testDeps(),
    );
    expect(res.status).toBe(401);
  });
});
