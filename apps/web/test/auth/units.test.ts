// M1-05 unit tests (no database): client IP, cookie attributes, CSRF checks, locale and time zone.
import { describe, expect, it } from "vitest";
import { anonymousScopeId, clientIp, ipHash, UNKNOWN_IP } from "../../src/server/client-ip.ts";
import { authConfigFromEnv } from "../../src/server/config.ts";
import { checkMutation } from "../../src/server/csrf.ts";
import { isSupportedTimeZone, localeFrom } from "../../src/server/locale.ts";
import { readSessionToken, sessionCookie, SESSION_COOKIE } from "../../src/server/session.ts";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIp", () => {
  it("prefers True-Client-IP (Render)", () => {
    expect(clientIp(h({ "true-client-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe(
      "198.51.100.7",
    );
  });
  it("else takes the LAST X-Forwarded-For hop, never the client-supplied first one", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 198.51.100.8" }))).toBe("198.51.100.8");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
  });
  it("is `unknown` with neither header", () => {
    expect(clientIp(h({}))).toBe(UNKNOWN_IP);
  });
  it("hashes with the secret (HMAC), never returning the IP", () => {
    const a = ipHash("198.51.100.7", "s1".repeat(16));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(ipHash("198.51.100.7", "s2".repeat(16)));
    expect(anonymousScopeId(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("session cookie", () => {
  it("has the __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and a Max-Age", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const c = sessionCookie("t".repeat(43), new Date(now.getTime() + 60_000), now);
    expect(c).toBe(`${SESSION_COOKIE}=${"t".repeat(43)}; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`);
  });
  it("reads only a well-formed token from the Cookie header", () => {
    const tok = "a".repeat(43);
    const r = (cookie: string) => new Request("http://x/", { headers: { cookie } });
    expect(readSessionToken(r(`other=1; ${SESSION_COOKIE}=${tok}`))).toBe(tok);
    expect(readSessionToken(r(`${SESSION_COOKIE}=short`))).toBeNull();
  });
});

describe("checkMutation", () => {
  const origin = "https://app.example.test";
  const mk = (headers: Record<string, string>) =>
    new Request(`${origin}/api/demo`, { method: "POST", headers });
  const ok = { "content-type": "application/json", origin, "idempotency-key": "k1" };
  it("passes JSON + matching Origin + key", () => {
    expect(checkMutation(mk(ok), origin)).toEqual({ ok: true, idempotencyKey: "k1" });
  });
  it.each([
    [{ ...ok, origin: "https://evil.example" }, 403],
    [{ ...ok, origin: "https://app.example.test.evil.example" }, 403],
    [{ ...ok, "idempotency-key": "" }, 400],
    [{ ...ok, "content-type": "text/plain" }, 415],
  ])("refuses %o with %i", (headers, status) => {
    const res = checkMutation(mk(headers), origin);
    expect(res.ok ? 0 : res.response.status).toBe(status);
  });
});

describe("locale and time zone", () => {
  it("picks the highest-weighted supported language", () => {
    expect(localeFrom("hi-IN,hi;q=0.9,en;q=0.8")).toBe("hi");
    expect(localeFrom("fr-FR,en;q=0.5,hi;q=0.4")).toBe("en");
    expect(localeFrom("en;q=0.2,hi;q=0.9")).toBe("hi");
    expect(localeFrom(null)).toBe("en");
  });
  it("accepts IANA zones (and their canonical aliases), refuses others", () => {
    for (const tz of ["Asia/Kolkata", "America/New_York", "UTC", "Etc/UTC"])
      expect(isSupportedTimeZone(tz)).toBe(true);
    for (const tz of ["Mars/Olympus", "", "../etc", "Asia/Kolkata; drop"])
      expect(isSupportedTimeZone(tz)).toBe(false);
  });
});

describe("authConfigFromEnv", () => {
  const env = { APP_BASE_URL: "https://app.example.test/", SESSION_SECRET: "x".repeat(44) };
  it("parses defaults and the allowlist", () => {
    const c = authConfigFromEnv({ ...env, EMAIL_RECIPIENT_ALLOWLIST: "A@example.test" });
    expect(c).toMatchObject({
      appOrigin: "https://app.example.test",
      resend: null,
      emailAllowlist: ["a@example.test"],
      demoPerIpPerDay: 3,
      demoGlobalMax: 200,
      llmWorkspaceCapUsd: "0.10",
    });
  });
  it("refuses a short SESSION_SECRET", () => {
    expect(() => authConfigFromEnv({ ...env, SESSION_SECRET: "short" })).toThrow();
  });
});
