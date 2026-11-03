// M4-03: PATCH /api/workspace persists the language switch (`workspaces.locale`) and the footer's
// time-zone control (`workspaces.timezone`), for the session's workspace only; a demo starts in the
// language of the page it was started from.
import { describe, expect, it } from "vitest";
import { postDemo } from "../../src/server/handlers/demo.ts";
import { getWorkspace, patchWorkspace } from "../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

interface Body {
  workspace: { id: string; locale: string; timezone: string };
}

describe.skipIf(!dbAvailable)("workspace settings (integration)", () => {
  it("persists locale and time zone for the session's workspace only", async () => {
    const deps = testDeps();
    const a = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp(), body: { timezone: "UTC" } }), deps));
    const b = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
    const bId = (await read(deps, b)).workspace.id;

    const res = await patchWorkspace(
      req("/api/workspace", {
        method: "PATCH",
        cookie: a,
        body: { locale: "hi", timezone: "Asia/Kolkata" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).workspace).toMatchObject({ locale: "hi", timezone: "Asia/Kolkata" });
    expect((await read(deps, a)).workspace).toMatchObject({ locale: "hi", timezone: "Asia/Kolkata" });

    // one field at a time; B is untouched
    await patchWorkspace(req("/api/workspace", { method: "PATCH", cookie: a, body: { locale: "en" } }), deps);
    expect((await read(deps, a)).workspace).toMatchObject({ locale: "en", timezone: "Asia/Kolkata" });
    expect((await read(deps, b)).workspace).toMatchObject({ id: bId, locale: "en", timezone: "UTC" });
  });

  it("refuses an unknown zone, an unknown locale, an empty body and extra fields", async () => {
    const deps = testDeps();
    const a = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
    for (const body of [{ timezone: "Mars/Olympus" }, { locale: "fr" }, {}, { locale: "hi", workspaceId: "x" }]) {
      const res = await patchWorkspace(req("/api/workspace", { method: "PATCH", cookie: a, body }), deps);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("needs a session and the CSRF headers", async () => {
    const deps = testDeps();
    const body = { locale: "hi" };
    expect((await patchWorkspace(req("/api/workspace", { method: "PATCH", body }), deps)).status).toBe(401);
    const a = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
    const cross = req("/api/workspace", { method: "PATCH", cookie: a, body, origin: "https://evil.example" });
    expect((await patchWorkspace(cross, deps)).status).toBe(403);
  });

  it("a demo started from /hi is a Hindi workspace whatever Accept-Language says", async () => {
    const deps = testDeps();
    const res = await postDemo(
      req("/api/demo", { ip: freshIp(), body: { locale: "hi" }, headers: { "accept-language": "en-US" } }),
      deps,
    );
    const cookie = cookieFrom(res);
    expect((await read(deps, cookie)).workspace.locale).toBe("hi");
  });
});

async function read(deps: ReturnType<typeof testDeps>, cookie: string): Promise<Body> {
  return (await (await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps)).json()) as Body;
}
