// Offline webhook verification over the M0-06 recordings (fixtures/paypal/webhooks/).
// - simulator/: real PayPal signatures over the bytes exactly as delivered (signed with the target
//   webhook's id when simulated by `webhook_id`, with the literal `WEBHOOK_ID` when simulated by `url`),
//   with the public cert PayPal served at `paypal-cert-url`. No network: the cert fetch is answered
//   from the fixture, and only for that exact URL.
// - deliveries/: real deliveries, scrubbed (so PayPal's signature no longer matches); each is re-signed
//   here with a key pair generated at runtime (never stored).
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpClient } from "../http/client.ts";
import { FIXTURES_DIR } from "../testing/fixture.ts";
import {
  createWebhookVerifier,
  headerValue,
  signedString,
  SIMULATOR_WEBHOOK_ID,
  WEBHOOK_MAX_SKEW_MS,
  type WebhookVerifyResult,
} from "./webhook-verify.ts";

const DeliveryFixtureSchema = z.object({
  meta: z.object({
    recorded_at: z.string(),
    env: z.literal("sandbox"),
    ticket: z.string(),
    scrubbed: z.boolean(),
    signed_webhook_id: z.string().optional(),
  }),
  event_type: z.string(),
  headers: z.record(z.string(), z.string()),
  raw_body: z.string(),
  cert_pem: z.string().optional(),
});
type DeliveryFixture = z.infer<typeof DeliveryFixtureSchema>;

function load(area: "simulator" | "deliveries"): [string, DeliveryFixture][] {
  const dir = `${FIXTURES_DIR}paypal/webhooks/${area}/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f, DeliveryFixtureSchema.parse(JSON.parse(readFileSync(dir + f, "utf8")))]);
}

const reason = (r: WebhookVerifyResult): string => (r.ok ? "ok" : r.reason);
const sentAt = (f: DeliveryFixture): number =>
  Date.parse(headerValue(f.headers, "paypal-transmission-time") ?? "");

/** Verifier whose only "network" is the fixture's cert, served for its exact URL. */
function offlineVerifier(f: DeliveryFixture, now = sentAt(f)) {
  const certUrl = headerValue(f.headers, "paypal-cert-url");
  const calls: string[] = [];
  const http = createHttpClient({
    vendor: "paypal-cert",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetch: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return url === certUrl && f.cert_pem !== undefined
        ? Promise.resolve(new Response(f.cert_pem, { status: 200 }))
        : Promise.reject(new Error(`no network in this test: ${url}`));
    },
  });
  return { calls, verifier: createWebhookVerifier({ http, now: () => now }) };
}

/** Flips one byte in the middle of the body (stays valid UTF-8 text). */
function flipByte(raw: string): string {
  const i = Math.floor(raw.length / 2);
  const c = raw.charCodeAt(i);
  return raw.slice(0, i) + String.fromCharCode(c === 0x41 ? 0x42 : 0x41) + raw.slice(i + 1);
}

const simulator = load("simulator");
const signer = (f: DeliveryFixture): string => f.meta.signed_webhook_id ?? "";
const deliveries = load("deliveries");

describe("simulator deliveries: PayPal's real signature, offline", () => {
  it("there is at least one, each with its cert, on the sandbox cert host", () => {
    expect(simulator.length).toBeGreaterThanOrEqual(1);
    // the url-addressed probe: PayPal's documented mock id
    expect(simulator.map(([, f]) => signer(f))).toContain(SIMULATOR_WEBHOOK_ID);
    for (const [, f] of simulator) {
      expect(f.cert_pem).toContain("BEGIN CERTIFICATE");
      expect(headerValue(f.headers, "paypal-cert-url")).toMatch(/^https:\/\/api\.sandbox\.paypal\.com\//);
    }
  });

  it.each(simulator)(
    "%s verifies with the webhook id it was signed with (one cert fetch, then cached)",
    async (_n, f) => {
      const { calls, verifier } = offlineVerifier(f);
      const input = { rawBody: f.raw_body, headers: f.headers, webhookId: signer(f) };
      expect(reason(await verifier.verifyWebhook(input))).toBe("ok");
      expect(reason(await verifier.verifyWebhook(input))).toBe("ok");
      expect(calls).toHaveLength(1);
    },
  );

  it.each(simulator)("%s: flipping one body byte fails it", async (_n, f) => {
    const { verifier } = offlineVerifier(f);
    const r = await verifier.verifyWebhook({
      rawBody: flipByte(f.raw_body),
      headers: f.headers,
      webhookId: signer(f),
    });
    expect(reason(r)).toBe("bad_signature");
  });

  it.each(simulator)("%s: re-serialising the JSON (same data) fails it", async (_n, f) => {
    const { verifier } = offlineVerifier(f);
    const reserialised = JSON.stringify(JSON.parse(f.raw_body), null, 1);
    const r = await verifier.verifyWebhook({
      rawBody: reserialised,
      headers: f.headers,
      webhookId: signer(f),
    });
    expect(reason(r)).toBe("bad_signature");
  });

  it.each(simulator)("%s: another webhook id fails it", async (_n, f) => {
    const { verifier } = offlineVerifier(f);
    const r = await verifier.verifyWebhook({
      rawBody: f.raw_body,
      headers: f.headers,
      webhookId: "WH-OTHER",
    });
    expect(reason(r)).toBe("bad_signature");
  });
});

describe("real deliveries (scrubbed), re-signed with a runtime key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const WEBHOOK = "WH-SPIKE-RESIGNED";

  function resigned(f: DeliveryFixture, now = sentAt(f)) {
    const message = signedString({
      transmissionId: headerValue(f.headers, "paypal-transmission-id") ?? "",
      transmissionTime: headerValue(f.headers, "paypal-transmission-time") ?? "",
      webhookId: WEBHOOK,
      rawBody: f.raw_body,
    });
    const headers = {
      ...f.headers,
      "paypal-transmission-sig": sign("sha256", Buffer.from(message), privateKey).toString("base64"),
    };
    const v = offlineVerifier({ ...f, cert_pem: undefined }, now);
    const certUrl = headerValue(f.headers, "paypal-cert-url") ?? "";
    v.verifier.cache.set(certUrl, {
      publicKey,
      validFrom: new Date(now - 86_400_000),
      validTo: new Date(now + 86_400_000),
    });
    return { ...v, headers };
  }

  it("covers the capture and the dispute event types, all scrubbed", () => {
    const types = new Set(deliveries.map(([, f]) => f.event_type));
    expect(types).toContain("PAYMENT.CAPTURE.COMPLETED");
    expect(types).toContain("CUSTOMER.DISPUTE.CREATED");
    for (const [, f] of deliveries) expect(f.meta.scrubbed).toBe(true);
  });

  it.each(deliveries)("%s verifies (no network: cert from the cache)", async (_n, f) => {
    const { calls, verifier, headers } = resigned(f);
    expect(reason(await verifier.verifyWebhook({ rawBody: f.raw_body, headers, webhookId: WEBHOOK }))).toBe(
      "ok",
    );
    expect(calls).toEqual([]);
  });

  it.each(deliveries)("%s: a wrong webhook id fails", async (_n, f) => {
    const { verifier, headers } = resigned(f);
    const r = await verifier.verifyWebhook({ rawBody: f.raw_body, headers, webhookId: "WH-OTHER" });
    expect(reason(r)).toBe("bad_signature");
  });

  it.each(deliveries)("%s: a stale transmission time fails", async (_n, f) => {
    const { verifier, headers } = resigned(f, sentAt(f) + WEBHOOK_MAX_SKEW_MS + 1_000);
    const r = await verifier.verifyWebhook({ rawBody: f.raw_body, headers, webhookId: WEBHOOK });
    expect(reason(r)).toBe("stale_transmission_time");
  });

  it.each(deliveries)("%s: a tampered body fails", async (_n, f) => {
    const { verifier, headers } = resigned(f);
    const r = await verifier.verifyWebhook({ rawBody: flipByte(f.raw_body), headers, webhookId: WEBHOOK });
    expect(reason(r)).toBe("bad_signature");
  });
});
