// Offline replay of the M0-06 live webhook-management run (fixtures/paypal/webhooks/management/).
// No network: an unmatched request fails the test.
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient } from "../http/client.ts";
import { loadFixture } from "../testing/fixture.ts";
import { startReplay, type Replay } from "../testing/replay.ts";
import { createTokenProvider } from "./token.ts";
import { createPayPalWebhooksClient, WEBHOOK_EVENT_TYPES } from "./webhooks.ts";

const M = "paypal/webhooks/management";
let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

function client(names: string[]) {
  replay = startReplay(["paypal/oauth/token", ...names.map((n) => `${M}/${n}`)]);
  const http = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0 });
  const tokens = createTokenProvider({
    http,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "replay", clientSecret: "replay" },
    cache: new Map(),
  });
  return createPayPalWebhooksClient({ http, tokens });
}

/** The spike's webhook URL, as recorded in the create request. */
const hookUrl = (): string => (loadFixture(`${M}/ensure-1.2`).request.body as { url: string }).url;

describe("ensureWebhook", () => {
  it("twice → one create, then a no-op on the same id", async () => {
    const wh = client(["ensure-1", "ensure-1.2", "ensure-2"]);
    const first = await wh.ensureWebhook(hookUrl(), WEBHOOK_EVENT_TYPES);
    const second = await wh.ensureWebhook(hookUrl(), WEBHOOK_EVENT_TYPES);
    expect(first.action).toBe("created");
    expect(second.action).toBe("unchanged");
    expect(second.webhook.id).toBe(first.webhook.id);
    expect(first.webhook.event_types.map((e) => e.name).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
    expect(replay?.unused()).toEqual([]);
  });

  it("different event types → one PATCH replace each way", async () => {
    const wh = client([
      "ensure-patch-subset",
      "ensure-patch-subset.2",
      "ensure-patch-back",
      "ensure-patch-back.2",
    ]);
    const subset = await wh.ensureWebhook(hookUrl(), WEBHOOK_EVENT_TYPES.slice(0, -1));
    expect(subset.action).toBe("patched");
    expect(subset.webhook.event_types).toHaveLength(WEBHOOK_EVENT_TYPES.length - 1);
    const back = await wh.ensureWebhook(hookUrl(), WEBHOOK_EVENT_TYPES);
    expect(back.action).toBe("patched");
    expect(back.webhook.event_types).toHaveLength(WEBHOOK_EVENT_TYPES.length);
    const patch = loadFixture(`${M}/ensure-patch-back.2`).request.body as { op: string; path: string }[];
    expect(patch.map((p) => [p.op, p.path])).toEqual([["replace", "/event_types"]]);
    expect(replay?.unused()).toEqual([]);
  });

  it("the app had no webhook before, exactly one after ensure, none after delete", async () => {
    const wh = client(["list-before", "list-after-ensure", "delete", "list-after"]);
    expect(await wh.listWebhooks()).toEqual([]);
    const [only, ...rest] = await wh.listWebhooks();
    expect(rest).toEqual([]);
    expect(only?.url).toBe(hookUrl());
    expect(await wh.deleteWebhook(only?.id ?? "")).toBe(true);
    expect(await wh.listWebhooks()).toEqual([]);
    expect(replay?.unused()).toEqual([]);
  });
});

describe("lookup, simulator, events, verify API", () => {
  it("ensureWebhookLookup finds the existing lookup (no second create)", async () => {
    const wh = client(["lookup-ensure", "lookup-list"]);
    const r = await wh.ensureWebhookLookup();
    expect(r.action).toBe("unchanged");
    expect(await wh.listWebhookLookups()).toHaveLength(1);
  });

  it("simulateEvent returns the sample event PayPal sends (202)", async () => {
    const wh = client(["simulate"]);
    const body = loadFixture(`${M}/simulate`).request.body as { webhook_id: string; event_type: string };
    const ev = await wh.simulateEvent({ webhookId: body.webhook_id, eventType: body.event_type });
    expect(ev.event_type).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(ev.id).toMatch(/^WH-/);
  });

  it("listWebhookEvents lists the run's real events (simulator events are not listed)", async () => {
    const wh = client(["events-list"]);
    const startTime =
      new URL(loadFixture(`${M}/events-list`).request.url).searchParams.get("start_time") ?? "";
    const list = await wh.listWebhookEvents({ startTime });
    expect(list.events.map((e) => e.event_type).sort()).toEqual([
      "CUSTOMER.DISPUTE.CREATED",
      "CUSTOMER.DISPUTE.UPDATED",
      "PAYMENT.CAPTURE.COMPLETED",
    ]);
  });

  it("verifyViaApi → SUCCESS for a real delivery", async () => {
    const wh = client(["verify-signature"]);
    const req = loadFixture(`${M}/verify-signature`).request.body as Record<string, unknown>;
    const headers = {
      "paypal-auth-algo": String(req.auth_algo),
      "paypal-cert-url": String(req.cert_url),
      "paypal-transmission-id": String(req.transmission_id),
      "paypal-transmission-sig": String(req.transmission_sig),
      "paypal-transmission-time": String(req.transmission_time),
    };
    const status = await wh.verifyViaApi({
      rawBody: JSON.stringify(req.webhook_event),
      headers,
      webhookId: String(req.webhook_id),
    });
    expect(status).toBe("SUCCESS");
  });
});
