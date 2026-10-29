// M0-06 spike C: webhooks on the PayPal SANDBOX through the product adapters.
//
//   pnpm tsx scripts/spikes/webhook-receiver.ts &                       # PORT_OFFSET=100 → :8180
//   cloudflared tunnel --url http://127.0.0.1:8180 &                    # quick tunnel, no account
//   pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-c.ts --url https://<x>.trycloudflare.com --record
//
// Registers a TEMPORARY webhook on the tunnel URL (ensureWebhook twice + a PATCH round trip), adds a
// webhook lookup, then triggers real events (a card capture, then a chargeback on it) and one
// simulator event per subscribed type. Every delivery is self-verified and (real ones) verified by the
// API. The spike webhook is deleted in `finally`. Management exchanges are recorded scrubbed into
// fixtures/paypal/webhooks/management/; real deliveries are scrubbed into deliveries/; simulator
// deliveries are kept byte-for-byte (PayPal sample data) with their public cert into simulator/.
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createPayPalDisputesClient,
  createPayPalOrdersClient,
  createPayPalWebhooksClient,
  createTokenProvider,
  createWebhookVerifier,
  firstCapture,
  PAYPAL_SANDBOX_BASE_URL,
  PayPalApiError,
  SIMULATOR_WEBHOOK_ID,
  VENDOR_TIMEOUTS_MS,
  WEBHOOK_EVENT_TYPES,
  type CertCache,
  type PayPalWebhooksClient,
  type TokenCache,
  type WebhookVerifier,
} from "../../packages/adapters/src/index.ts";
import { createRecorder, type Recorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber, type Scrubber } from "../../packages/adapters/src/testing/scrub.ts";
import { RECEIVER_DIR, type DeliveryMeta } from "./webhook-receiver.ts";

const TICKET = "M0-06";
const CARD = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Asha Verma" };
const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/paypal/webhooks/", import.meta.url));
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (event: string, data: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ t: Math.round((Date.now() - T0) / 1000), event, ...data }));
};

interface Delivery {
  readonly file: string;
  readonly meta: DeliveryMeta;
  readonly raw: string;
  readonly event: { id: string; event_type: string; create_time: string; resource: Record<string, unknown> };
}

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`missing ${name} in the environment`);
    process.exit(2);
  }
  return v;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function readDeliveries(since: number): Delivery[] {
  return readdirSync(RECEIVER_DIR)
    .filter((f) => f.endsWith(".meta.json") && Number(f.split("-")[0]) >= since)
    .sort()
    .map((f) => {
      const base = join(RECEIVER_DIR, f.replace(/\.meta\.json$/, ""));
      const raw = readFileSync(`${base}.body`, "utf8");
      return {
        file: base,
        meta: JSON.parse(readFileSync(`${base}.meta.json`, "utf8")) as DeliveryMeta,
        raw,
        event: JSON.parse(raw) as Delivery["event"],
      };
    });
}

/** Waits (local disk, 2 s ticks) until `match` finds a delivery; undefined after `timeoutMs`. */
async function waitFor(match: (d: Delivery) => boolean, timeoutMs: number): Promise<Delivery | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = readDeliveries(T0).find(match);
    if (hit !== undefined) return hit;
    await sleep(2_000);
  }
  return undefined;
}

const fileName = (eventType: string): string => eventType.toLowerCase().replaceAll(".", "-");

function writeJson(rel: string, value: unknown): string {
  let file = join(FIXTURE_DIR, `${rel}.json`);
  for (let n = 2; ; n++) {
    try {
      readFileSync(file);
      file = join(FIXTURE_DIR, `${rel}.${String(n)}.json`);
    } catch {
      break;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Real delivery → scrubbed fixture (the original signature no longer matches; tests re-sign). */
function deliveryFixture(d: Delivery, s: Scrubber, note: string): unknown {
  return {
    meta: {
      recorded_at: new Date().toISOString(),
      env: "sandbox",
      ticket: TICKET,
      scrubbed: true,
      received_at: d.meta.received_at,
      note,
    },
    event_type: d.event.event_type,
    headers: d.meta.headers,
    raw_body: JSON.stringify(s.value(JSON.parse(d.raw))),
  };
}

/** Simulator delivery → byte-for-byte fixture plus the public cert, so its real signature verifies offline. */
function simulatorFixture(d: Delivery, certPem: string): unknown {
  return {
    meta: {
      recorded_at: new Date().toISOString(),
      env: "sandbox",
      ticket: TICKET,
      scrubbed: false,
      received_at: d.meta.received_at,
      note: "simulator (mock) delivery kept byte-for-byte: PayPal sample data, signed with webhook id WEBHOOK_ID",
    },
    event_type: d.event.event_type,
    headers: d.meta.headers,
    raw_body: d.raw,
    cert_pem: certPem,
  };
}

async function setupWebhook(wh: PayPalWebhooksClient, rec: Recorder, url: string) {
  rec.label("management/list-before", "GET /v1/notifications/webhooks before the spike");
  const before = await wh.listWebhooks();
  rec.label("management/ensure-1", "ensureWebhook #1: list + create");
  const first = await wh.ensureWebhook(url, WEBHOOK_EVENT_TYPES);
  rec.label("management/ensure-2", "ensureWebhook #2: list only (no-op)");
  const second = await wh.ensureWebhook(url, WEBHOOK_EVENT_TYPES);
  rec.label("management/ensure-patch-subset", "ensureWebhook with one type fewer: list + PATCH");
  const subset = await wh.ensureWebhook(url, WEBHOOK_EVENT_TYPES.slice(0, -1));
  rec.label("management/ensure-patch-back", "ensureWebhook with the full set again: list + PATCH");
  const back = await wh.ensureWebhook(url, WEBHOOK_EVENT_TYPES);
  rec.label("management/list-after-ensure", "GET /v1/notifications/webhooks after both ensure runs");
  const afterEnsure = await wh.listWebhooks();
  const ensure = {
    before: before.map((w) => w.url),
    actions: [first.action, second.action, subset.action, back.action],
    sameId: first.webhook.id === second.webhook.id,
    withUrlAfterEnsure: afterEnsure.filter((w) => w.url === url).length,
    countBefore: before.length,
    countAfterEnsure: afterEnsure.length,
  };
  log("ensure", ensure);
  return { webhookId: first.webhook.id, ensure };
}

async function lookup(wh: PayPalWebhooksClient, rec: Recorder): Promise<Record<string, unknown>> {
  try {
    rec.label("management/lookup-ensure", "ensureWebhookLookup: list + create if none");
    const r = await wh.ensureWebhookLookup();
    rec.label("management/lookup-list", "GET /v1/notifications/webhooks-lookup");
    const all = await wh.listWebhookLookups();
    return { action: r.action, count: all.length };
  } catch (err) {
    return {
      error: err instanceof PayPalApiError ? { status: err.status, name: err.paypal?.name } : String(err),
    };
  }
}

async function main(): Promise<void> {
  if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const url = arg("--url");
  if (url?.startsWith("https://") !== true) throw new Error("--url https://<tunnel host> is required");
  const hookUrl = `${url.replace(/\/$/, "")}/api/webhooks/paypal`;
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const foreignIds = new Set<string>();
  const scrubber = createScrubber({
    secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens, ...foreignIds],
  });
  const rec = createRecorder({ dir: FIXTURE_DIR, ticket: TICKET, scrubber });
  let recording = false;
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      if (recording && process.argv.includes("--record") && !e.request.url.endsWith("/v1/oauth2/token")) {
        rec.onExchange(e);
      }
    },
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  liveTokens.add((await tokens.getToken()).value);
  const wh = createPayPalWebhooksClient({ http, tokens });
  const pp = createPayPalOrdersClient({ http, tokens });
  const dc = createPayPalDisputesClient({ http, tokens, env: () => process.env.PAYPAL_ENV ?? "sandbox" });

  const merchantOf = async (orderId: string): Promise<string | undefined> => {
    const res = await tokens.withToken((b) =>
      http.request({
        method: "GET",
        url: `${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders/${orderId}`,
        headers: { authorization: `Bearer ${b}` },
      }),
    );
    const o = JSON.parse(res.bodyText) as { purchase_units?: { payee?: { merchant_id?: string } }[] };
    return o.purchase_units?.[0]?.payee?.merchant_id;
  };

  // The app's other webhooks (e.g. a real one) must never land in a fixture: their ids are scrubbed.
  for (const w of await wh.listWebhooks()) if (w.url !== hookUrl) foreignIds.add(w.id);
  log("existing-webhooks", { count: foreignIds.size });

  recording = true;
  const out: Record<string, unknown> = { started: new Date(T0).toISOString(), hookUrl };
  const { webhookId, ensure } = await setupWebhook(wh, rec, hookUrl);
  out.ensure = ensure;
  try {
    out.lookup = await lookup(wh, rec);
    log("lookup", out.lookup as Record<string, unknown>);
    recording = false;
    const live = createWebhookVerifier({
      http: createHttpClient({ vendor: "paypal-cert", timeoutMs: VENDOR_TIMEOUTS_MS.paypal }),
    });
    Object.assign(out, await realEvents(pp, dc, merchantOf, live, webhookId));
    Object.assign(
      out,
      await simulatorEvents(
        wh,
        rec,
        webhookId,
        () => (recording = true),
        () => (recording = false),
      ),
    );
    recording = true;
    rec.label("management/events-list", "GET /v1/notifications/webhooks-events since the run start");
    const events = await wh.listWebhookEvents({ startTime: new Date(T0 - 60_000).toISOString() });
    out.eventsListed = events.events.map((e) => e.event_type);
    recording = false;
    out.verify = await verifyAll(wh, rec, webhookId, scrubber, (v) => (recording = v));
  } finally {
    recording = true;
    rec.label("management/delete", "DELETE the spike webhook");
    out.deleted = await wh.deleteWebhook(webhookId);
    rec.label("management/list-after", "GET /v1/notifications/webhooks after delete");
    const after = await wh.listWebhooks();
    out.after = {
      urls: after.map((w) => w.url),
      spikeGone: !after.some((w) => w.id === webhookId),
      count: after.length,
    };
    recording = false;
    log("cleanup", { deleted: out.deleted, ...(out.after as Record<string, unknown>) });
    const summary = join(RECEIVER_DIR, "summary.json");
    writeFileSync(summary, `${JSON.stringify(out, null, 2)}\n`);
    log("summary", { file: summary });
  }
}

type Pp = ReturnType<typeof createPayPalOrdersClient>;
type Dc = ReturnType<typeof createPayPalDisputesClient>;

/** Self-verify right on arrival with the real clock (the route's view); undefined → not delivered. */
async function verifyNow(v: WebhookVerifier, d: Delivery | undefined, webhookId: string) {
  if (d === undefined) return undefined;
  const t = performance.now();
  const r = await v.verifyWebhook({ rawBody: d.raw, headers: d.meta.headers, webhookId });
  return {
    result: r.ok ? "SUCCESS" : r,
    ms: Number((performance.now() - t).toFixed(3)),
    ageAtVerify_ms: Date.now() - d.meta.received_ms,
  };
}

async function realEvents(
  pp: Pp,
  dc: Dc,
  merchantOf: (orderId: string) => Promise<string | undefined>,
  v: WebhookVerifier,
  webhookId: string,
): Promise<Record<string, unknown>> {
  const order = await pp.createOrder({
    amount: { currency_code: "USD", value: "37.00" },
    customId: `spike-${randomUUID()}`,
    referenceId: "m0-06-webhooks",
    card: CARD,
    requestId: randomUUID(),
  });
  const capturedAt = Date.now();
  const capture = firstCapture(order);
  if (capture === undefined) throw new Error(`order ${order.id} has no capture`);
  realCaptureId = capture.id;
  const merchantId = await merchantOf(order.id);
  log("capture", { order: order.id, capture: capture.id, status: capture.status });
  const completed = await waitFor(
    (d) => d.event.event_type === "PAYMENT.CAPTURE.COMPLETED" && d.event.resource.id === capture.id,
    10 * 60_000,
  );
  const completedNow = await verifyNow(v, completed, webhookId);
  log("delivery", { type: "PAYMENT.CAPTURE.COMPLETED", ok: completed !== undefined, verify: completedNow });
  if (merchantId === undefined) throw new Error("no payee.merchant_id on the order");
  const { dispute_id } = await dc.processChargeback({
    captureId: capture.id,
    amount: capture.amount,
    merchantId,
    requestId: randomUUID(),
  });
  const chargebackAt = Date.now();
  log("chargeback", { dispute: dispute_id });
  const created = await waitFor(
    (d) => d.event.event_type === "CUSTOMER.DISPUTE.CREATED" && d.event.resource.dispute_id === dispute_id,
    15 * 60_000,
  );
  const createdNow = await verifyNow(v, created, webhookId);
  log("delivery", { type: "CUSTOMER.DISPUTE.CREATED", ok: created !== undefined, verify: createdNow });
  // Let the hold (PAYMENT.CAPTURE.PENDING, ~3 min) and dispute updates arrive too.
  const holdBy = chargebackAt + 6 * 60_000;
  if (Date.now() < holdBy) await sleep(holdBy - Date.now());
  const lat = (d: Delivery | undefined, from: number) =>
    d === undefined
      ? null
      : {
          fromTrigger_ms: d.meta.received_ms - from,
          fromEventCreate_ms: d.meta.received_ms - Date.parse(d.event.create_time),
        };
  return {
    real: { order: order.id, capture: capture.id, dispute: dispute_id, capturedAt, chargebackAt },
    verifyOnArrival: { "PAYMENT.CAPTURE.COMPLETED": completedNow, "CUSTOMER.DISPUTE.CREATED": createdNow },
    latency: {
      "PAYMENT.CAPTURE.COMPLETED": lat(completed, capturedAt),
      "CUSTOMER.DISPUTE.CREATED": lat(created, chargebackAt),
    },
  };
}

async function simulatorEvents(
  wh: PayPalWebhooksClient,
  rec: Recorder,
  webhookId: string,
  on: () => void,
  off: () => void,
): Promise<Record<string, unknown>> {
  const sims: Record<string, { id: string; at: number; error?: unknown }> = {};
  for (const [i, type] of WEBHOOK_EVENT_TYPES.entries()) {
    if (i === 0) {
      on();
      rec.label("management/simulate", `POST /v1/notifications/simulate-event ${type}`);
    }
    try {
      const ev = await wh.simulateEvent({ webhookId, eventType: type });
      sims[type] = { id: ev.id, at: Date.now() };
      simIds.add(ev.id);
    } catch (err) {
      sims[type] = {
        id: "",
        at: Date.now(),
        error: err instanceof PayPalApiError ? err.paypal : String(err),
      };
    }
    off();
  }
  log("simulated", { types: Object.keys(sims).length });
  const latency: Record<string, number | null> = {};
  for (const [type, s] of Object.entries(sims)) {
    const d = await waitFor((x) => x.event.id === s.id, s.id === "" ? 0 : 5 * 60_000);
    latency[type] = d === undefined ? null : d.meta.received_ms - s.at;
  }
  log("simulator-deliveries", latency);
  return { simulated: sims, simulatorLatency: latency };
}

async function verifyAll(
  wh: PayPalWebhooksClient,
  rec: Recorder,
  webhookId: string,
  scrubber: Scrubber,
  setRecording: (v: boolean) => void,
): Promise<Record<string, unknown>> {
  const http = createHttpClient({ vendor: "paypal-cert", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  const cache: CertCache = new Map();
  const rows: Record<string, unknown>[] = [];
  let recordedVerify = false;
  for (const d of readDeliveries(T0)) {
    const simulated = isSim(d);
    const id = simulated ? SIMULATOR_WEBHOOK_ID : webhookId;
    // Verified after the run: the clock is pinned to the receive time (what the route would see).
    const verifier = createWebhookVerifier({ http, cache, now: () => d.meta.received_ms });
    const t = performance.now();
    const self = await verifier.verifyWebhook({ rawBody: d.raw, headers: d.meta.headers, webhookId: id });
    const coldMs = performance.now() - t;
    let api: string | undefined;
    if (!simulated) {
      setRecording(!recordedVerify);
      if (!recordedVerify)
        rec.label(
          "management/verify-signature",
          "POST /v1/notifications/verify-webhook-signature (real delivery)",
        );
      try {
        api = await wh.verifyViaApi({ rawBody: d.raw, headers: d.meta.headers, webhookId });
      } catch (err) {
        api = `error ${err instanceof PayPalApiError ? String(err.status) : String(err)}`;
      }
      setRecording(false);
      recordedVerify = true;
    }
    const certUrl = d.meta.headers["paypal-cert-url"] ?? "";
    const row = {
      event: d.event.id,
      type: d.event.event_type,
      simulated,
      self: self.ok ? "SUCCESS" : self,
      api,
      coldMs,
      certUrl,
    };
    rows.push(row);
    log("verified", row);
    if (process.argv.includes("--record")) {
      if (simulated) {
        if (!existsFixture(`simulator/${fileName(d.event.event_type)}`)) {
          writeJson(
            `simulator/${fileName(d.event.event_type)}`,
            simulatorFixture(d, await certPem(http, certUrl)),
          );
        }
      } else {
        writeJson(
          `deliveries/${fileName(d.event.event_type)}`,
          deliveryFixture(
            d,
            scrubber,
            `real delivery; self-verify ${self.ok ? "SUCCESS" : "FAILURE"}, API ${api ?? "n/a"}`,
          ),
        );
      }
    }
  }
  return { rows, warm: await warmTiming(http, cache, webhookId) };
}

const simIds = new Set<string>();
let realCaptureId = "";
/** Simulator deliveries: ids returned by simulate-event, or anything not about the spike's capture. */
function isSim(d: Delivery): boolean {
  return simIds.has(d.event.id) || (realCaptureId !== "" && !d.raw.includes(realCaptureId));
}

function existsFixture(rel: string): boolean {
  try {
    readFileSync(join(FIXTURE_DIR, `${rel}.json`));
    return true;
  } catch {
    return false;
  }
}

async function certPem(http: ReturnType<typeof createHttpClient>, url: string): Promise<string> {
  return (await http.request({ method: "GET", url, redirect: "manual" })).bodyText;
}

/** Warm-cache self-verify time over one real delivery: 200 runs, median / p95 / max in ms. */
async function warmTiming(
  http: ReturnType<typeof createHttpClient>,
  cache: CertCache,
  webhookId: string,
): Promise<Record<string, unknown>> {
  const d = readDeliveries(T0).find((x) => !isSim(x));
  if (d === undefined) return { error: "no real delivery" };
  const verifier = createWebhookVerifier({ http, cache, now: () => d.meta.received_ms });
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    const r = await verifier.verifyWebhook({ rawBody: d.raw, headers: d.meta.headers, webhookId });
    times.push(performance.now() - t);
    if (!r.ok && i === 0) return { error: r };
  }
  times.sort((a, b) => a - b);
  const at = (p: number) =>
    Number((times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0).toFixed(3));
  return { runs: times.length, median_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

main().catch((err: unknown) => {
  const e =
    err instanceof PayPalApiError
      ? { status: err.status, name: err.paypal?.name, debug: err.debugId, details: err.paypal?.details }
      : String(err);
  console.error("spike failed:", JSON.stringify(e));
  process.exit(1);
});
