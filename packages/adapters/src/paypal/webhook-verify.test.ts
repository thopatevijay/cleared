// The cert-URL SSRF guard and header checks of the webhook self-verifier (ADR 0012). Every bad cert URL
// is refused before any HTTP call (a counting fetch proves it); a redirect from an allowed host is
// never followed (one call, `redirect: "manual"`, and the target is never fetched).
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client.ts";
import {
  checkCertUrl,
  createWebhookVerifier,
  signedString,
  WEBHOOK_MAX_SKEW_MS,
  type WebhookVerifyResult,
} from "./webhook-verify.ts";

const NOW = Date.parse("2026-10-29T08:00:00Z");
const GOOD_CERT = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";

function countingVerifier(respond?: (url: string) => Response) {
  const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
  const http = createHttpClient({
    vendor: "paypal-cert",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, redirect: init?.redirect });
      return respond ? Promise.resolve(respond(url)) : Promise.reject(new Error("no network in this test"));
    },
  });
  return { calls, verifier: createWebhookVerifier({ http, now: () => NOW }) };
}

function headers(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    "paypal-transmission-id": "6f0a1c40-b5a0-11f0-9a5e-0d3a0c1b2c3d",
    "paypal-transmission-time": new Date(NOW).toISOString(),
    "paypal-transmission-sig": "c2lnbmF0dXJl",
    "paypal-cert-url": GOOD_CERT,
    "paypal-auth-algo": "SHA256withRSA",
    ...over,
  };
}

const reason = (r: WebhookVerifyResult): string => (r.ok ? "ok" : r.reason);

describe("cert host allowlist (no network for a bad URL)", () => {
  const cases: [string, string, string][] = [
    ["http://", "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", "cert_url_not_https"],
    [
      "suffix attack",
      "https://api.paypal.com.evil.test/v1/notifications/certs/CERT-1",
      "cert_host_not_allowed",
    ],
    ["IPv4 literal", "https://151.101.1.1/v1/notifications/certs/CERT-1", "cert_host_ip_literal"],
    ["IPv6 literal", "https://[::1]/v1/notifications/certs/CERT-1", "cert_host_ip_literal"],
    ["localhost", "https://localhost/v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["api-m host", "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["subdomain", "https://x.api.paypal.com/v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["explicit port", "https://api.paypal.com:8443/v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["credentials", "https://user@api.paypal.com/v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["trailing dot", "https://api.paypal.com./v1/notifications/certs/CERT-1", "cert_host_not_allowed"],
    ["file:", "file:///etc/passwd", "cert_url_not_https"],
    ["garbage", "not a url", "cert_url_invalid"],
  ];

  it.each(cases)("%s is rejected without a network call", async (_name, url, expected) => {
    const { calls, verifier } = countingVerifier();
    const r = await verifier.verifyWebhook({
      rawBody: "{}",
      headers: headers({ "paypal-cert-url": url }),
      webhookId: "WH",
    });
    expect(reason(r)).toBe(expected);
    expect(calls).toEqual([]);
  });

  it("accepts exactly the two PayPal hosts", () => {
    expect(checkCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1").ok).toBe(true);
    expect(checkCertUrl(GOOD_CERT).ok).toBe(true);
    expect(checkCertUrl("https://API.PAYPAL.COM/v1/notifications/certs/CERT-1").ok).toBe(true);
  });

  it("a redirect from an allowed host is not followed: one call, manual mode, rejected", async () => {
    const { calls, verifier } = countingVerifier(
      () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    );
    const r = await verifier.verifyWebhook({ rawBody: "{}", headers: headers(), webhookId: "WH" });
    expect(reason(r)).toBe("cert_redirect_refused");
    expect(calls).toEqual([{ url: GOOD_CERT, redirect: "manual" }]);
  });

  it("a non-PEM body from an allowed host is rejected and not cached", async () => {
    const { calls, verifier } = countingVerifier(() => new Response("<html>nope</html>", { status: 200 }));
    expect(reason(await verifier.verifyWebhook({ rawBody: "{}", headers: headers(), webhookId: "WH" }))).toBe(
      "cert_invalid",
    );
    expect(calls).toHaveLength(1);
    expect(verifier.cache.size).toBe(0);
  });
});

describe("header and time checks (no network)", () => {
  it.each([
    "paypal-transmission-id",
    "paypal-transmission-time",
    "paypal-transmission-sig",
    "paypal-cert-url",
    "paypal-auth-algo",
  ])("missing %s → missing_header", async (name) => {
    const { calls, verifier } = countingVerifier();
    const r = await verifier.verifyWebhook({
      rawBody: "{}",
      headers: headers({ [name]: undefined }),
      webhookId: "WH",
    });
    expect(reason(r)).toBe("missing_header");
    expect(calls).toEqual([]);
  });

  it("an empty webhook id → missing_header", async () => {
    const { verifier } = countingVerifier();
    expect(reason(await verifier.verifyWebhook({ rawBody: "{}", headers: headers(), webhookId: "" }))).toBe(
      "missing_header",
    );
  });

  it("an algorithm other than SHA256withRSA → unsupported_algo", async () => {
    const { verifier } = countingVerifier();
    const r = await verifier.verifyWebhook({
      rawBody: "{}",
      headers: headers({ "paypal-auth-algo": "SHA1withRSA" }),
      webhookId: "WH",
    });
    expect(reason(r)).toBe("unsupported_algo");
  });

  it.each([
    ["older than 5 min", NOW - WEBHOOK_MAX_SKEW_MS - 1_000],
    ["more than 5 min ahead", NOW + WEBHOOK_MAX_SKEW_MS + 1_000],
  ])("transmission time %s → stale_transmission_time", async (_n, at) => {
    const { calls, verifier } = countingVerifier();
    const r = await verifier.verifyWebhook({
      rawBody: "{}",
      headers: headers({ "paypal-transmission-time": new Date(at).toISOString() }),
      webhookId: "WH",
    });
    expect(reason(r)).toBe("stale_transmission_time");
    expect(calls).toEqual([]);
  });
});

describe("signature over the cached key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const body = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"}';

  function signed(webhookId: string, rawBody: string = body) {
    const h = headers();
    const message = signedString({
      transmissionId: h["paypal-transmission-id"] ?? "",
      transmissionTime: h["paypal-transmission-time"] ?? "",
      webhookId,
      rawBody,
    });
    return {
      ...h,
      "paypal-transmission-sig": sign("sha256", Buffer.from(message), privateKey).toString("base64"),
    };
  }

  function seeded(validTo = NOW + 86_400_000) {
    const v = countingVerifier();
    v.verifier.cache.set(GOOD_CERT, {
      publicKey,
      validFrom: new Date(NOW - 86_400_000),
      validTo: new Date(validTo),
    });
    return v;
  }

  it("verifies from the cache without a network call; header names are case-insensitive", async () => {
    const { calls, verifier } = seeded();
    const upper = Object.fromEntries(Object.entries(signed("WH-A")).map(([k, v]) => [k.toUpperCase(), v]));
    expect((await verifier.verifyWebhook({ rawBody: body, headers: upper, webhookId: "WH-A" })).ok).toBe(
      true,
    );
    expect(
      (
        await verifier.verifyWebhook({
          rawBody: Buffer.from(body),
          headers: new Headers(signed("WH-A") as Record<string, string>),
          webhookId: "WH-A",
        })
      ).ok,
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  it("an expired cached cert → cert_not_valid_now", async () => {
    const { verifier } = seeded(NOW - 1);
    expect(
      reason(await verifier.verifyWebhook({ rawBody: body, headers: signed("WH-A"), webhookId: "WH-A" })),
    ).toBe("cert_not_valid_now");
  });

  it("a signature that is not base64 of a valid signature → bad_signature", async () => {
    const { verifier } = seeded();
    const h = { ...signed("WH-A"), "paypal-transmission-sig": "!!!" };
    expect(reason(await verifier.verifyWebhook({ rawBody: body, headers: h, webhookId: "WH-A" }))).toBe(
      "bad_signature",
    );
  });
});
