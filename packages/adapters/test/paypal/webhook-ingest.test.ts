// Webhook ingest units (M1-04): body cap, envelope, routing of every recorded delivery, sandbox cert host.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../src/testing/fixture.ts";
import {
  captureIdOf,
  createWebhookAuthenticator,
  readRawBody,
  routeWebhook,
  WebhookEnvelopeSchema,
} from "../../src/paypal/webhook-ingest.ts";
import type { WebhookVerifier } from "../../src/paypal/webhook-verify.ts";

function envelopes(area: string) {
  const dir = `${FIXTURES_DIR}paypal/webhooks/${area}/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const { raw_body } = JSON.parse(readFileSync(dir + f, "utf8")) as { raw_body: string };
      return [f, WebhookEnvelopeSchema.parse(JSON.parse(raw_body))] as const;
    });
}

describe("readRawBody", () => {
  it("returns the exact text", async () => {
    const raw = '{"a":  1}\n';
    expect(await readRawBody(new Request("http://x", { method: "POST", body: raw }))).toEqual({
      ok: true,
      raw,
    });
  });
  it("refuses a streamed body over the cap", async () => {
    const r = new Request("http://x", { method: "POST", body: "x".repeat(11) });
    expect(await readRawBody(r, 10)).toEqual({ ok: false, reason: "too_large" });
  });
  it("refuses a declared content-length over the cap without reading", async () => {
    const r = new Request("http://x", {
      method: "POST",
      body: "x",
      headers: { "content-length": "2000000" },
    });
    expect(await readRawBody(r)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("routeWebhook over every recorded delivery", () => {
  const expected: Record<string, string> = {
    "deliveries/payment-capture-completed.json": "capture_sync:0M327451J9579884Y",
    "simulator/payment-capture-completed.json": "capture_sync:42311647XV020574X",
    "simulator/url-payment-capture-completed.json": "capture_sync:42311647XV020574X",
    "simulator/payment-capture-declined.json": "capture_sync:7U133281TB3277326",
    "simulator/payment-capture-denied.json": "capture_sync:1YH34677BD7819356",
    "simulator/payment-capture-pending.json": "capture_sync:0C90432034385860N",
    // v1 refund resource: the capture comes from its `capture` link
    "simulator/payment-capture-refunded.json": "capture_sync:5LK72275CG489890D",
    // v1 reversal sample has no capture reference at all: stored only
    "simulator/payment-capture-reversed.json": "store_only",
  };
  const all = [
    ...envelopes("deliveries").map(([f, e]) => [`deliveries/${f}`, e] as const),
    ...envelopes("simulator").map(([f, e]) => [`simulator/${f}`, e] as const),
  ];
  it.each(all)("%s", (name, e) => {
    const r = routeWebhook(e);
    const got = r.kind === "capture_sync" ? `capture_sync:${r.captureId}` : r.kind;
    expect(got).toBe(expected[name] ?? "store_only");
    if (e.event_type.startsWith("CUSTOMER.DISPUTE.")) expect(r.kind).toBe("store_only");
  });

  it("a v2 refund resource routes by its rel=up capture link", () => {
    const resource = {
      id: "1JU08902781691411",
      links: [
        { href: "https://api.paypal.com/v2/payments/refunds/1JU08902781691411", rel: "self" },
        { href: "https://api.paypal.com/v2/payments/captures/2GG279541U471931P", rel: "up" },
      ],
    };
    expect(captureIdOf("PAYMENT.CAPTURE.REFUNDED", resource)).toBe("2GG279541U471931P");
  });
  it("an id that is not a PayPal id is not routed", () => {
    expect(captureIdOf("PAYMENT.CAPTURE.COMPLETED", { id: "../../x" })).toBeNull();
  });
});

describe("createWebhookAuthenticator", () => {
  const never: WebhookVerifier = {
    cache: new Map(),
    verifyWebhook: () => Promise.reject(new Error("must not be called")),
  };
  const auth = (env: "sandbox" | "live") =>
    createWebhookAuthenticator({
      verifier: never,
      verifyViaApi: () => Promise.reject(new Error("must not be called")),
      webhookId: "WH",
      env,
    });
  it("refuses the live cert host on sandbox (and the sandbox host on live) before any call", async () => {
    const h = (u: string) => ({ "paypal-cert-url": u });
    expect(await auth("sandbox")({ rawBody: "{}", headers: h("https://api.paypal.com/c") })).toEqual({
      ok: false,
      reason: "cert_host_wrong_env",
    });
    expect(await auth("live")({ rawBody: "{}", headers: h("https://api.sandbox.paypal.com/c") })).toEqual({
      ok: false,
      reason: "cert_host_wrong_env",
    });
  });
  it("falls back to the API only when self-verify is inconclusive", async () => {
    const calls: string[] = [];
    const a = (reason: "cert_fetch_failed" | "unsupported_algo" | "bad_signature") =>
      createWebhookAuthenticator({
        verifier: { cache: new Map(), verifyWebhook: () => Promise.resolve({ ok: false, reason }) },
        verifyViaApi: () => {
          calls.push(reason);
          return Promise.resolve("SUCCESS");
        },
        webhookId: "WH",
        env: "sandbox",
      })({ rawBody: "{}", headers: {} });
    expect(await a("cert_fetch_failed")).toEqual({ ok: true, method: "api" });
    expect(await a("unsupported_algo")).toEqual({ ok: true, method: "api" });
    expect(await a("bad_signature")).toEqual({ ok: false, reason: "bad_signature" });
    expect(calls).toEqual(["cert_fetch_failed", "unsupported_algo"]);
  });
  it("an API error is not a pass", async () => {
    const r = await createWebhookAuthenticator({
      verifier: {
        cache: new Map(),
        verifyWebhook: () => Promise.resolve({ ok: false, reason: "cert_fetch_failed" }),
      },
      verifyViaApi: () => Promise.reject(new Error("PayPal down")),
      webhookId: "WH",
      env: "sandbox",
    })({ rawBody: "{}", headers: {} });
    expect(r).toEqual({ ok: false, reason: "api_verification_error" });
  });
});
