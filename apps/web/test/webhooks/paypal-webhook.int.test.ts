// POST /api/webhooks/paypal over the M0-06 recordings (M1-04 AC: fixture replay, tampering, fallback,
// SSRF, dedupe). Simulator deliveries carry PayPal's real signature (clock injected to their
// transmission time, msw serving their cert); real deliveries are scrubbed, so they are re-signed here
// with a runtime key. Every outbound request goes through msw and is recorded.
import { HttpResponse, http as mswHttp } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postPayPalWebhook } from "../../src/server/handlers/paypal-webhook.ts";
import { dbAvailable } from "../support/db-available.ts";
import {
  certUrlOf,
  cleanup,
  counts,
  disputeSyncJobs,
  eventIdOf,
  flipByte,
  loadDeliveries,
  outbound,
  post,
  resign,
  RESIGN_WEBHOOK_ID,
  routeDeps,
  seedResignKey,
  sentAt,
  serveCert,
  serveFixture,
  server,
  testProducer,
  type Delivery,
} from "./support.ts";

const simulator = loadDeliveries("simulator");
const deliveries = loadDeliveries("deliveries");
const allIds = [...simulator, ...deliveries].map(([, d]) => eventIdOf(d));
const signer = (d: Delivery): string => d.meta.signed_webhook_id ?? "";
const [, capture] = deliveries.find(([n]) => n === "payment-capture-completed.json") ?? [];
if (capture === undefined) throw new Error("fixture deliveries/payment-capture-completed.json missing");
const captureEventId = eventIdOf(capture);

describe.skipIf(!dbAvailable)("POST /api/webhooks/paypal", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledFrame: "error" });
    await cleanup(allIds);
  });
  afterEach(async () => {
    server.resetHandlers();
    outbound.length = 0;
    await cleanup(allIds);
  });
  afterAll(async () => {
    server.close();
    await (await testProducer()).stop({ graceful: false });
  });

  describe("fixture replay", () => {
    it.each(simulator)("simulator %s: real signature → 200 and one row", async (_n, d) => {
      serveCert(d);
      const deps = await routeDeps({ webhookId: signer(d), now: sentAt(d) });
      const res = await postPayPalWebhook(post(d.raw_body, d.headers), deps);
      expect(res.status).toBe(200);
      expect((await counts([eventIdOf(d)])).rows).toBe(1);
      expect(outbound).toEqual([`GET ${certUrlOf(d)}`]);
    });

    it.each(deliveries)("real delivery %s re-signed → 200 and one row", async (_n, d) => {
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      seedResignKey(deps.verifier, d, sentAt(d));
      const res = await postPayPalWebhook(post(d.raw_body, resign(d)), deps);
      expect(res.status).toBe(200);
      expect((await counts([eventIdOf(d)])).rows).toBe(1);
      expect(outbound).toEqual([]);
    });

    it("routes: capture events get one capture-sync job; dispute events re-fetch the disputed capture and stay received", async () => {
      for (const [, d] of deliveries) {
        const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
        seedResignKey(deps.verifier, d, sentAt(d));
        expect((await postPayPalWebhook(post(d.raw_body, resign(d)), deps)).status).toBe(200);
      }
      expect((await counts([captureEventId])).jobs).toBe(1);
      const disputes = deliveries.filter(([, d]) => d.event_type.startsWith("CUSTOMER.DISPUTE."));
      expect((await counts(disputes.map(([, d]) => eventIdOf(d)))).jobs).toBe(0);
      // BL-01 6489621553: one re-fetch of the disputed capture per dispute event, with no eventId
      expect(await disputeSyncJobs("0M327451J9579884Y")).toBe(disputes.length);
      const raw = await (
        await routeDeps({ webhookId: "x", now: 0 })
      ).db.$client.query<{ status: string; verified: boolean }>(
        "select status, verified from webhook_events where event_id = any($1)",
        [deliveries.map(([, d]) => eventIdOf(d))],
      );
      expect(raw.rows.every((r) => r.status === "received" && r.verified)).toBe(true);
    });

    it("never special-cases WEBHOOK_ID: a url-simulated delivery fails against a real webhook id (BL-01 6489621772)", async () => {
      const [, url] = simulator.find(([n]) => n.startsWith("url-")) ?? [];
      if (url === undefined) throw new Error("url-simulated fixture missing");
      serveCert(url);
      const deps = await routeDeps({ webhookId: "9H93406745674050R", now: sentAt(url) });
      expect((await postPayPalWebhook(post(url.raw_body, url.headers), deps)).status).toBe(401);
      expect((await counts([eventIdOf(url)])).rows).toBe(0);
    });
  });

  describe("tampering → 401 and no row", () => {
    const d = capture;
    it("one changed byte in the body", async () => {
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      seedResignKey(deps.verifier, d, sentAt(d));
      const res = await postPayPalWebhook(post(flipByte(d.raw_body), resign(d)), deps);
      expect(res.status).toBe(401);
      expect((await counts([captureEventId])).rows).toBe(0);
    });
    it("a wrong webhook id", async () => {
      const deps = await routeDeps({ webhookId: "WH-SOMEONE-ELSE", now: sentAt(d) });
      seedResignKey(deps.verifier, d, sentAt(d));
      expect((await postPayPalWebhook(post(d.raw_body, resign(d)), deps)).status).toBe(401);
      expect((await counts([captureEventId])).rows).toBe(0);
    });
    it("a stale transmission time (5 min skew + 1 s)", async () => {
      const now = sentAt(d) + 5 * 60_000 + 1_000;
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now });
      seedResignKey(deps.verifier, d, now);
      expect((await postPayPalWebhook(post(d.raw_body, resign(d)), deps)).status).toBe(401);
      expect((await counts([captureEventId])).rows).toBe(0);
    });
    it("a body over 1 MB → 413 before verification", async () => {
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      const res = await postPayPalWebhook(post("x".repeat(1_048_577), resign(d)), deps);
      expect(res.status).toBe(413);
      expect(outbound).toEqual([]);
    });
  });

  describe("fallback: cert fetch timeout → verify-webhook-signature (M0-06 management fixture)", () => {
    const d = capture;
    const hangCert = (): void => {
      server.use(mswHttp.get(certUrlOf(d), () => new Promise<Response>(() => undefined)));
    };

    it("SUCCESS → 200 and one row", async () => {
      hangCert();
      serveFixture("paypal/oauth/token");
      serveFixture("paypal/webhooks/management/verify-signature");
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d), certTimeoutMs: 200 });
      const res = await postPayPalWebhook(post(d.raw_body, d.headers), deps);
      expect(res.status).toBe(200);
      expect(outbound).toEqual([
        `GET ${certUrlOf(d)}`,
        "POST https://api-m.sandbox.paypal.com/v1/oauth2/token",
        "POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
      ]);
      expect((await counts([captureEventId])).rows).toBe(1);
    });

    it("FAILURE → 401 and no row", async () => {
      hangCert();
      serveFixture("paypal/oauth/token");
      serveFixture("paypal/webhooks/management/verify-signature", () => ({ verification_status: "FAILURE" }));
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d), certTimeoutMs: 200 });
      expect((await postPayPalWebhook(post(d.raw_body, d.headers), deps)).status).toBe(401);
      expect((await counts([captureEventId])).rows).toBe(0);
    });

    it("a bad signature never falls back to the API", async () => {
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      seedResignKey(deps.verifier, d, sentAt(d));
      expect((await postPayPalWebhook(post(flipByte(d.raw_body), resign(d)), deps)).status).toBe(401);
      expect(outbound).toEqual([]);
    });
  });

  describe("SSRF: a hostile cert URL → 401 with no outbound request", () => {
    const d = capture;
    const cases = [
      ["http: scheme", "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1"],
      ["look-alike host", "https://api.paypal.com.evil.example/v1/notifications/certs/CERT-1"],
      ["IPv4 literal", "https://169.254.169.254/latest/meta-data"],
      ["IPv6 literal", "https://[::1]/cert"],
      ["live host while on sandbox", "https://api.paypal.com/v1/notifications/certs/CERT-1"],
    ] as const;
    it.each(cases)("%s", async (_label, certUrl) => {
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      const res = await postPayPalWebhook(
        post(d.raw_body, { ...resign(d), "paypal-cert-url": certUrl }),
        deps,
      );
      expect(res.status).toBe(401);
      expect(outbound).toEqual([]);
      expect((await counts([captureEventId])).rows).toBe(0);
    });

    it("a redirect from the allowed host is not followed and does not fall back", async () => {
      server.use(
        mswHttp.get(certUrlOf(d), () =>
          HttpResponse.redirect("http://169.254.169.254/latest/meta-data", 302),
        ),
      );
      const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
      expect((await postPayPalWebhook(post(d.raw_body, resign(d)), deps)).status).toBe(401);
      expect(outbound).toEqual([`GET ${certUrlOf(d)}`]);
      expect((await counts([captureEventId])).rows).toBe(0);
    });
  });

  it("dedupe: the same delivery posted 5 times concurrently → 5 × 200, 1 row, 1 job", async () => {
    const d = capture;
    const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(d) });
    seedResignKey(deps.verifier, d, sentAt(d));
    const headers = resign(d);
    const res = await Promise.all(
      Array.from({ length: 5 }, () => postPayPalWebhook(post(d.raw_body, headers), deps)),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const outcomes = await Promise.all(
      res.map(async (r) => ((await r.json()) as { outcome: string }).outcome),
    );
    expect(outcomes.filter((o) => o === "stored")).toHaveLength(1);
    expect(await counts([captureEventId])).toEqual({ rows: 1, jobs: 1 });
  });

  it("no PAYPAL_WEBHOOK_ID → 503, nothing stored", async () => {
    const deps = { ...(await routeDeps({ webhookId: "x", now: sentAt(capture) })), authenticate: null };
    expect((await postPayPalWebhook(post(capture.raw_body, capture.headers), deps)).status).toBe(503);
    expect((await counts([captureEventId])).rows).toBe(0);
  });
});
