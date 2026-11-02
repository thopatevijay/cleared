// M3-10: record the live review-hold pool's orders and captures (after the owner approved them as the
// sandbox buyer and `pool:capture` captured them) on the PayPal SANDBOX, through the product adapters,
// into fixtures/paypal/{orders/pool,captures}/. Read-only: one order GET and one capture GET per row.
//
//   node --env-file=<path to .env> scripts/spikes/m3-10-pool-record.ts <label>:<orderId>:<captureId> …
//
// Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them; every file
// is scrubbed before it touches the disk (fixtures/README.md).
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createPayPalOrdersClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
  type TokenCache,
} from "../../packages/adapters/src/index.ts";
import { createRecorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../../packages/adapters/src/testing/scrub.ts";

const TICKET = "M3-10";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing ${name} in the environment`);
  return v;
}

async function main(): Promise<void> {
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const rows = process.argv.slice(2).map((a) => {
    const [label, orderId, captureId] = a.split(":");
    if (label === undefined || orderId === undefined || captureId === undefined) {
      throw new Error("usage: <label>:<orderId>:<captureId> …");
    }
    return { label, orderId, captureId };
  });
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({
    secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens],
  });
  const dir = fileURLToPath(new URL("../../fixtures/paypal/", import.meta.url));
  const recorder = createRecorder({ dir, ticket: TICKET, scrubber });
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: recorder.onExchange,
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  recorder.label("oauth/token-m3-10");
  liveTokens.add((await tokens.getToken()).value);
  const orders = createPayPalOrdersClient({ http, tokens });
  const out: unknown[] = [];
  for (const r of rows) {
    recorder.label(
      `orders/pool/get-order-${r.label}`,
      "review-hold pool order after buyer approval + pool:capture",
    );
    const order = await orders.getOrder(r.orderId);
    recorder.label(
      `captures/pool-${r.label}`,
      "review-hold pool capture GET (PayPal-wallet, Payment Review on)",
    );
    const capture = await orders.getCapture(r.captureId);
    out.push({
      label: r.label,
      order: order.id,
      orderStatus: order.status,
      capture: capture.id,
      status: capture.status,
      reason: capture.status_details?.reason ?? null,
    });
  }
  console.log(JSON.stringify({ written: recorder.written, out }, null, 1));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "record failed");
  process.exitCode = 1;
});
