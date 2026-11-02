// M3-03 AC 1: probe the "Shipped by" dropdown codes that PayPal's published carrier list lacks against
// the PayPal SANDBOX Orders v2 track API (`POST /v2/checkout/orders/{id}/track`, the same call and body
// as the `add_tracking` action), and record each answer into fixtures/paypal/tracking/carrier-probe/.
//
//   node --env-file=<main checkout>/.env node_modules/tsx/dist/cli.mjs scripts/spikes/m3-03-carrier-probe.ts
//
// One owned test payment (custom_id = a synthetic workspace id, as in m1-04-test-payment.ts; no
// database), then one tracker per code with a dummy tracking number and notify_payer false, plus an
// IND_DELHIVERY control first (a code PayPal is known to accept). Only the track exchanges are recorded
// (scrubbed). Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createOwnedTestPayment,
  createPayPalOrdersClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  PayPalApiError,
  VENDOR_TIMEOUTS_MS,
  type TokenCache,
} from "../../packages/adapters/src/index.ts";
import { createRecorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../../packages/adapters/src/testing/scrub.ts";

const TICKET = "M3-03";
const CONTROL = "IND_DELHIVERY";
const CODES = [
  "_2EBOX",
  "_360LION",
  "_3JMSLOGISTICS",
  "_4_72",
  "_6LS",
  "BEL_DHL",
  "GLS_ITALY",
  "JITSU",
  "SKYEXPRESS_INTERNATIONAL",
] as const;

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing ${name} in the environment`);
  return v;
}

interface ProbeResult {
  readonly code: string;
  readonly status: number;
  readonly debug_id: string | null;
  readonly error_name: string | null;
  readonly issue: string | null;
  readonly description: string | null;
  readonly fixture: string;
}

async function main(): Promise<void> {
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({ secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens] });
  const dir = fileURLToPath(new URL("../../fixtures/paypal/", import.meta.url));
  const recorder = createRecorder({ dir, ticket: TICKET, scrubber });
  let recording = false;
  let calls = 0;
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      calls += 1;
      if (recording) recorder.onExchange(e);
    },
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  liveTokens.add((await tokens.getToken()).value);
  const orders = createPayPalOrdersClient({ http, tokens });
  if (process.argv.includes("--verify")) {
    recording = true;
    await verify(dir, recorder, orders);
    console.log(JSON.stringify({ calls }));
    return;
  }

  const workspaceId = randomUUID();
  const paid = await createOwnedTestPayment(
    { orders, claimOrder: async () => undefined },
    { workspaceId, requestId: randomUUID() },
  );
  console.log(JSON.stringify({ orderId: paid.orderId, captureId: paid.captureId, captureStatus: paid.status }));

  recording = true;
  const results: ProbeResult[] = [];
  for (const code of [CONTROL, ...CODES]) {
    const fixture = `tracking/carrier-probe/${code.toLowerCase().replace(/^_/, "u")}`;
    recorder.label(fixture, `carrier probe: ${code} (dummy tracking number, notify_payer false)`);
    let meta: { status: number; debugId: string | undefined } | undefined;
    try {
      await orders.trackOrder(paid.orderId, {
        captureId: paid.captureId,
        trackingNumber: `CLRPROBE${randomBytes(4).toString("hex").toUpperCase()}`,
        carrier: code,
        notifyPayer: false,
        requestId: randomUUID(),
        onResponse: (m) => {
          meta = m;
        },
      });
      results.push({ code, status: meta?.status ?? 0, debug_id: meta?.debugId ?? null, error_name: null, issue: null, description: null, fixture });
    } catch (err) {
      if (!(err instanceof PayPalApiError)) throw err;
      const d = err.paypal?.details?.[0];
      results.push({
        code,
        status: err.status,
        debug_id: err.debugId ?? null,
        error_name: err.paypal?.name ?? null,
        issue: d?.issue ?? null,
        description: d?.description ?? null,
        fixture,
      });
    }
    console.log(JSON.stringify(results[results.length - 1]));
  }
  recording = false;
  const probedAt = new Date().toISOString();
  const out = {
    meta: {
      recorded_at: probedAt,
      env: "sandbox",
      ticket: TICKET,
      scrubbed: true,
      note: "Summary of the carrier probe (scripts/spikes/m3-03-carrier-probe.ts): ids and PayPal debug ids only; the exchanges are the sibling files",
    },
    probed_at: probedAt,
    env: "sandbox",
    endpoint: "POST /v2/checkout/orders/{id}/track",
    order_id: paid.orderId,
    capture_id: paid.captureId,
    calls,
    results,
  };
  writeFileSync(`${dir}tracking/carrier-probe/results.json`, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ calls }));
}

/**
 * `--verify` (after a probe run): reads each 201 tracker back with the legacy
 * `GET /v1/shipping/trackers/{capture}-{number}` to see the carrier PayPal stored, and sends one
 * negative control (a code on no list) to show the track API validates `carrier` at all.
 */
async function verify(
  dir: string,
  recorder: ReturnType<typeof createRecorder>,
  orders: ReturnType<typeof createPayPalOrdersClient>,
): Promise<void> {
  const resultsFile = `${dir}tracking/carrier-probe/results.json`;
  const run = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    order_id: string;
    capture_id: string;
    results: ProbeResult[];
    stored?: unknown[];
    negative_control?: unknown;
  };
  const stored: { code: string; stored_carrier: unknown; status: unknown; fixture: string }[] = [];
  for (const r of run.results.filter((x) => x.status === 201)) {
    const sent = JSON.parse(readFileSync(`${dir}${r.fixture}.json`, "utf8")) as {
      request: { body: { tracking_number: string } };
    };
    const fixture = `${r.fixture}-get`;
    recorder.label(fixture, `legacy tracker read-back for ${r.code}`);
    await orders.getLegacyTracker(run.capture_id, sent.request.body.tracking_number);
    const got = JSON.parse(readFileSync(`${dir}${fixture}.json`, "utf8")) as {
      response: { body: { carrier?: unknown; status?: unknown } };
    };
    stored.push({ code: r.code, stored_carrier: got.response.body.carrier ?? null, status: got.response.body.status ?? null, fixture });
    console.log(JSON.stringify(stored[stored.length - 1]));
  }
  const bogus = "CLEARED_NOT_A_CARRIER";
  const fixture = "tracking/carrier-probe/negative-control";
  recorder.label(fixture, `negative control: ${bogus} is on neither list`);
  let negative: Record<string, unknown>;
  try {
    let meta: { status: number; debugId: string | undefined } | undefined;
    await orders.trackOrder(run.order_id, {
      captureId: run.capture_id,
      trackingNumber: `CLRPROBE${randomBytes(4).toString("hex").toUpperCase()}`,
      carrier: bogus,
      notifyPayer: false,
      requestId: randomUUID(),
      onResponse: (m) => {
        meta = m;
      },
    });
    negative = { code: bogus, status: meta?.status ?? 0, debug_id: meta?.debugId ?? null, fixture };
  } catch (err) {
    if (!(err instanceof PayPalApiError)) throw err;
    const d = err.paypal?.details?.[0];
    negative = {
      code: bogus,
      status: err.status,
      debug_id: err.debugId ?? null,
      error_name: err.paypal?.name ?? null,
      issue: d?.issue ?? null,
      description: d?.description ?? null,
      fixture,
    };
  }
  console.log(JSON.stringify(negative));
  writeFileSync(resultsFile, `${JSON.stringify({ ...run, stored, negative_control: negative }, null, 2)}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
