// M0-04 spike A: one live PayPal SANDBOX run through the product adapters, recording every exchange.
//
//   pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-a.ts --record
//
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them.
// Refuses to run unless PAYPAL_ENV is unset or "sandbox". Writes scrubbed fixtures to fixtures/paypal/.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createPayPalOrdersClient,
  createTokenProvider,
  firstCapture,
  hasScope,
  PAYPAL_SANDBOX_BASE_URL,
  PayPalApiError,
  TRANSACTION_SEARCH_SCOPE,
  VENDOR_TIMEOUTS_MS,
  type CardSource,
  type TokenCache,
} from "../../packages/adapters/src/index.ts";
import { createRecorder, type Recorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../../packages/adapters/src/testing/scrub.ts";

const TICKET = "M0-04";
// PayPal's published sandbox test Visa (developer.paypal.com/tools/sandbox/card-testing); synthetic holder.
const CARD: CardSource = {
  number: "4111111111111111",
  expiry: "2030-12",
  securityCode: "123",
  name: "Asha Verma",
};

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    console.error(`missing ${name} in the environment`);
    process.exit(2);
  }
  return v;
}

async function expectError(step: string, run: () => Promise<unknown>): Promise<PayPalApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PayPalApiError) return err;
    throw err;
  }
  throw new Error(`${step}: expected a PayPal error, got success`);
}

async function main(): Promise<void> {
  if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const record = process.argv.includes("--record");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({
    secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens],
  });
  const dir = fileURLToPath(new URL("../../fixtures/paypal/", import.meta.url));
  const recorder: Recorder | undefined = record
    ? createRecorder({ dir, ticket: TICKET, scrubber })
    : undefined;
  const label = (name: string, note?: string): void => recorder?.label(name, note);

  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    ...(recorder === undefined ? {} : { onExchange: recorder.onExchange }),
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  const pp = createPayPalOrdersClient({ http, tokens });
  const out: Record<string, unknown> = {};

  label("oauth/token", "client_credentials; the scope list is response.body.scope");
  const token = await tokens.getToken();
  liveTokens.add(token.value);
  out.scopes = token.scopes;
  out.transaction_search_scope = hasScope(token, TRANSACTION_SEARCH_SCOPE);
  out.expires_in_s = Math.round((token.expiresAt - Date.now()) / 1000);

  // Order A (goods): create with card → captured in the same call; same PayPal-Request-Id replays.
  const reqA = randomUUID();
  const customA = `spike-${randomUUID()}`;
  const orderA = {
    amount: { currency_code: "USD", value: "42.00" },
    customId: customA,
    referenceId: "goods-a",
    card: CARD,
    requestId: reqA,
  };
  label("orders/create-goods-a", "card payment_source, intent CAPTURE, custom_id spike-<uuid>");
  const a = await pp.createOrder(orderA);
  let capA = firstCapture(a);
  if (a.status === "APPROVED") {
    label("orders/capture-goods-a");
    capA = firstCapture(await pp.captureOrder(a.id, randomUUID()));
  } else {
    label("errors/capture-already-captured", "capture on an order the card create already captured");
    const e = await expectError("capture again", () => pp.captureOrder(a.id, randomUUID()));
    out.capture_again = { status: e.status, name: e.paypal?.name, issue: e.paypal?.details?.[0]?.issue };
  }
  if (capA === undefined) throw new Error("order A has no capture");
  label("orders/create-goods-a-replay", "same PayPal-Request-Id as create-goods-a");
  const aAgain = await pp.createOrder(orderA);
  out.order_a = {
    id: a.id,
    status: a.status,
    capture: capA.id,
    capture_status: capA.status,
    replay_same_id: aAgain.id === a.id,
  };

  label("orders/get-order-a");
  const gotA = await pp.getOrder(a.id);
  label("orders/get-capture-a", "is custom_id on the capture?");
  const gotCap = await pp.getCapture(capA.id);
  out.get_order_status = gotA.status;
  out.capture_has_custom_id = gotCap.custom_id === customA;
  out.capture_breakdown = gotCap.seller_receivable_breakdown;

  // Order B (goods): tracked with OTHER.
  label("orders/create-goods-b");
  const b = await pp.createOrder({
    amount: { currency_code: "USD", value: "18.50" },
    customId: `spike-${randomUUID()}`,
    referenceId: "goods-b",
    card: CARD,
    requestId: randomUUID(),
  });
  const capB = firstCapture(b);
  if (capB === undefined) throw new Error("order B has no capture");

  label("tracking/track-ind-delhivery");
  const tA = await pp.trackOrder(a.id, {
    captureId: capA.id,
    trackingNumber: `SPKA${String(Date.now())}`,
    carrier: "IND_DELHIVERY",
    requestId: randomUUID(),
  });
  label("tracking/track-other", "carrier OTHER + carrier_name_other");
  const tB = await pp.trackOrder(b.id, {
    captureId: capB.id,
    trackingNumber: `SPKB${String(Date.now())}`,
    carrier: "OTHER",
    carrierNameOther: "Kampala Express Couriers",
    requestId: randomUUID(),
  });
  out.trackers = [tA, tB].map((o) =>
    o.purchase_units[0]?.shipping?.trackers?.map((t) => ({ id: t.id, status: t.status })),
  );

  // Order C (service): legacy trackers-batch COMPLETED with no tracking number, then read back.
  label("orders/create-service-c");
  const c = await pp.createOrder({
    amount: { currency_code: "USD", value: "120.00" },
    customId: `spike-${randomUUID()}`,
    referenceId: "service-c",
    card: CARD,
    requestId: randomUUID(),
  });
  const capC = firstCapture(c);
  if (capC === undefined) throw new Error("order C has no capture");
  label(
    "tracking/trackers-batch-completed",
    "legacy /v1/shipping/trackers-batch, status COMPLETED, no tracking number",
  );
  const batch = await pp.markCompleted([capC.id]);
  label("tracking/get-legacy-tracker", "read-back of <capture id>-NOTRACKER");
  const legacy = await pp.getLegacyTracker(capC.id);
  out.service = {
    order: c.id,
    capture: capC.id,
    batch_errors: batch.errors.length,
    legacy_status: legacy.status,
  };

  // Error cases.
  label("errors/400-validation", "amount.value not a number");
  const e400 = await expectError("400", () =>
    pp.createOrder({
      ...orderA,
      amount: { currency_code: "USD", value: "forty-two" },
      requestId: randomUUID(),
    }),
  );
  label("errors/404-capture");
  const e404 = await expectError("404", () => pp.getCapture("0NOTACAPTURE0000"));
  out.errors = {
    e400: [e400.status, e400.paypal?.name, e400.debugId !== undefined],
    e404: [e404.status, e404.paypal?.name],
  };

  out.revoked = await revokedTokenPath(
    http,
    credentials,
    token.value,
    a.id,
    label,
    tokens,
    liveTokens,
    cache,
  );
  console.log(JSON.stringify(out, null, 2));
  if (recorder !== undefined)
    console.log(`wrote ${String(recorder.written.length)} fixtures:\n${recorder.written.join("\n")}`);
}

/** Terminates the live token at PayPal, then GETs with it: 401 → one forced refresh → 200. */
async function revokedTokenPath(
  http: ReturnType<typeof createHttpClient>,
  credentials: { clientId: string; clientSecret: string },
  value: string,
  orderId: string,
  label: (name: string, note?: string) => void,
  tokens: ReturnType<typeof createTokenProvider>,
  liveTokens: Set<string>,
  cache: TokenCache,
): Promise<unknown> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  label("oauth/terminate-token", "POST /v1/oauth2/token/terminate (revokes the cached token)");
  const term = await http.request({
    method: "POST",
    url: `${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token/terminate`,
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: `token=${encodeURIComponent(value)}&token_type_hint=ACCESS_TOKEN`,
    idempotent: true,
  });
  label(
    "errors/401-revoked-token",
    "GET with the revoked token → 401; .2 = forced re-mint; .3 = retried GET → 200",
  );
  const pp = createPayPalOrdersClient({ http, tokens });
  const before = cache.get(credentials.clientId)?.token?.value;
  const order = await pp.getOrder(orderId);
  const after = (await tokens.getToken()).value;
  liveTokens.add(after);
  return { terminate_status: term.status, refreshed: before !== after, order_status: order.status };
}

main().catch((err: unknown) => {
  const e =
    err instanceof PayPalApiError
      ? { status: err.status, name: err.paypal?.name, debug: err.debugId, details: err.paypal?.details }
      : String(err);
  console.error("spike failed:", JSON.stringify(e));
  process.exit(1);
});
