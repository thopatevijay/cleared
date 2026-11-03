// M4-05 headers: the page CSP (nonce scripts, no 'unsafe-eval' outside `next dev`, no framing, no
// plugins, no <base>), the API CSP, and HSTS / nosniff / Referrer-Policy / frame denial on every response.
// The production build is checked over HTTP by the ticket's gate (`curl -sI`) and by e2e/csp.spec.ts
// (every page and the Bryntum calendar load with no CSP violation).
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.ts";
import proxy from "../../proxy.ts";
import {
  API_CSP,
  newNonce,
  pageCsp,
  reportOriginFromDsn,
  STATIC_SECURITY_HEADERS,
} from "../../src/lib/security-headers.ts";

const directives = (csp: string): Map<string, string> =>
  new Map(
    csp.split(";").map((d) => {
      const [name = "", ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")];
    }),
  );

describe("page CSP", () => {
  const prod = directives(pageCsp("abc123", { dev: false, reportOrigin: null }));

  it("scripts: self + the request's nonce only; no 'unsafe-eval', 'unsafe-inline' or 'strict-dynamic'", () => {
    expect(prod.get("script-src")).toBe("'self' 'nonce-abc123'");
  });

  it("no framing, no plugins, no <base>, forms only to us, everything else same-origin", () => {
    expect(prod.get("frame-ancestors")).toBe("'none'");
    expect(prod.get("object-src")).toBe("'none'");
    expect(prod.get("base-uri")).toBe("'none'");
    expect(prod.get("form-action")).toBe("'self'");
    expect(prod.get("default-src")).toBe("'self'");
    expect(prod.get("connect-src")).toBe("'self'");
  });

  it("'unsafe-eval' only under `next dev`; Sentry's ingest origin is the only extra connect-src", () => {
    const dev = directives(pageCsp("n", { dev: true, reportOrigin: null }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    const origin = reportOriginFromDsn("https://pub@o123.ingest.sentry.io/456");
    expect(origin).toBe("https://o123.ingest.sentry.io");
    expect(reportOriginFromDsn("http://pub@evil.example/1")).toBeNull();
    expect(reportOriginFromDsn("")).toBeNull();
    expect(directives(pageCsp("n", { dev: false, reportOrigin: origin })).get("connect-src")).toBe(
      "'self' https://o123.ingest.sentry.io",
    );
  });

  it("a fresh nonce per call", () => {
    expect(new Set(Array.from({ length: 50 }, newNonce)).size).toBe(50);
  });
});

describe("proxy (pages)", () => {
  it("every page response carries the nonce CSP; the request carries the same one for Next", () => {
    const a = proxy(new NextRequest("http://localhost:3000/en/payments", { headers: { cookie: "__Host-cleared_session=x" } }));
    const b = proxy(new NextRequest("http://localhost:3000/en"));
    const csp = a.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'(;|$)/);
    expect(csp).not.toContain("unsafe-eval");
    expect(b.headers.get("content-security-policy")).not.toBe(csp);
  });

  it("the acknowledgement page keeps its stricter CSP, no-referrer and noindex", () => {
    const res = proxy(new NextRequest("http://localhost:3000/en/ack/sometoken"));
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("next.config headers()", () => {
  it("HSTS, nosniff, Referrer-Policy, frame denial on every path; the API CSP on API routes and probes", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    const keys = new Map(all?.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(keys.get("strict-transport-security")).toMatch(/^max-age=(\d+); includeSubDomains$/);
    expect(Number(/max-age=(\d+)/.exec(keys.get("strict-transport-security") ?? "")?.[1])).toBeGreaterThanOrEqual(31_536_000);
    expect(keys.get("x-content-type-options")).toBe("nosniff");
    expect(keys.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(keys.get("x-frame-options")).toBe("DENY");
    expect(all?.headers).toEqual([...STATIC_SECURITY_HEADERS]);
    for (const source of ["/api/:path*", "/healthz", "/readyz"]) {
      const r = rules.find((x) => x.source === source);
      expect(r?.headers, source).toEqual([{ key: "Content-Security-Policy", value: API_CSP }]);
    }
    // No CSP on pages here: it would stack with the proxy's nonce CSP.
    expect(all?.headers.some((h) => h.key.toLowerCase() === "content-security-policy")).toBe(false);
    expect(directives(API_CSP).get("default-src")).toBe("'none'");
  });
});
