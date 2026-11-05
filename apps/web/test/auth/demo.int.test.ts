// M1-05 AC: demo caps (per IP, global, concurrent), cookie attributes, CSRF and Idempotency-Key replay.
import { platform } from "@cleared/db";
import { describe, expect, it } from "vitest";
import { ipHash } from "../../src/server/client-ip.ts";
import { postDemo } from "../../src/server/handlers/demo.ts";
import { REPLAY_HEADER } from "../../src/server/idempotency.ts";
import { freshIp, req, testDb, testDeps } from "../support/db.ts";
import { dbAvailable } from "../support/db-available.ts";

async function countFor(ip: string, secret: string): Promise<{ workspaces: number; refusals: number }> {
  const h = ipHash(ip, secret);
  const db = testDb();
  const ws = await platform(db).auth.countDemoWorkspacesSince(new Date(0), h);
  const r = await db.$client.query<{ n: string }>(
    "select count(*) as n from audit_log where action = 'cap.refused' and detail->>'ipHash' = $1",
    [h],
  );
  return { workspaces: ws, refusals: Number(r.rows[0]?.n) };
}

describe.skipIf(!dbAvailable)("POST /api/demo (integration)", () => {
  it("the 4th demo request from one IP in a day → 429 with Retry-After; refusal is audited", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const codes: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 4; i++) {
      last = await postDemo(req("/api/demo", { ip }), deps);
      codes.push(last.status);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
    // BL-01 6649565560: the exact wait until the oldest of the 3 leaves the rolling 24 h window
    const retryAfter = Number(last?.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(86_400 - 120);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    const body = (await last?.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error).toMatchObject({
      code: "rate_limited",
      details: { cap: "demo_per_ip", limit: 3, windowHours: 24 },
    });
    const retryAt = Date.parse(String(body.error.details["retryAt"]));
    expect(Math.abs(retryAt - (Date.now() + retryAfter * 1000))).toBeLessThan(120_000);
    expect(await countFor(ip, deps.config.sessionSecret)).toEqual({ workspaces: 3, refusals: 1 });
  });

  it("with the global max at 2 (on top of the live demos already in the database), the 3rd → 429", async () => {
    const live = await platform(testDb()).auth.countLiveDemoWorkspaces(new Date());
    const deps = testDeps({ config: { demoGlobalMax: live + 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await postDemo(req("/api/demo", { ip: freshIp() }), deps)).status);
    expect(codes).toEqual([201, 201, 429]);
  });

  it("10 concurrent requests from one IP create exactly 3 workspaces", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => postDemo(req("/api/demo", { ip }), deps)),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
    expect((await countFor(ip, deps.config.sessionSecret)).workspaces).toBe(3);
  });

  it("creates a demo workspace with the LLM budget, expiry and an IP hash (never the raw IP)", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const res = await postDemo(
      req("/api/demo", { ip, headers: { "accept-language": "hi-IN,hi;q=0.9" } }),
      deps,
    );
    expect(res.status).toBe(201);
    const rows = await testDb().$client.query<{
      locale: string;
      llm_budget_usd: string;
      expires_at: Date;
      created_ip_hash: string;
    }>(
      "select locale, llm_budget_usd, expires_at, created_ip_hash from workspaces where created_ip_hash = $1",
      [ipHash(ip, deps.config.sessionSecret)],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ locale: "hi", llm_budget_usd: "0.10" });
    expect(rows.rows[0]?.expires_at.toISOString()).toBe("2026-12-16T00:00:00.000Z");
    expect(rows.rows[0]?.created_ip_hash).not.toContain(ip);
  });

  it("Set-Cookie has the __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain", async () => {
    const res = await postDemo(req("/api/demo", { ip: freshIp() }), testDeps());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-cleared_session=[A-Za-z0-9_-]{43};/);
    const attrs = cookie.split(";").map((a) => a.trim());
    expect(attrs).toEqual(expect.arrayContaining(["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]));
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });
});

describe.skipIf(!dbAvailable)("CSRF and Idempotency-Key (integration)", () => {
  it("a foreign Origin → 403; no Origin → 403; no Idempotency-Key → 400; not JSON → 415", async () => {
    const deps = testDeps();
    const ip = freshIp();
    expect((await postDemo(req("/api/demo", { ip, origin: "https://evil.example" }), deps)).status).toBe(403);
    expect((await postDemo(req("/api/demo", { ip, origin: null }), deps)).status).toBe(403);
    const noKey = await postDemo(req("/api/demo", { ip, key: null }), deps);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    const form = req("/api/demo", { ip, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect((await postDemo(form, deps)).status).toBe(415);
    expect((await countFor(ip, deps.config.sessionSecret)).workspaces).toBe(0);
  });

  it("an identical Idempotency-Key replay returns the stored response and creates nothing new", async () => {
    const deps = testDeps();
    const ip = freshIp();
    const first = await postDemo(req("/api/demo", { ip, key: "replay-1" }), deps);
    const second = await postDemo(req("/api/demo", { ip, key: "replay-1" }), deps);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get(REPLAY_HEADER)).toBe("true");
    expect(second.headers.get("set-cookie")).toBeNull(); // the session token is never stored
    expect((await countFor(ip, deps.config.sessionSecret)).workspaces).toBe(1);
  });
});
