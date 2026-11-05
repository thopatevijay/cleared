// BL-01 (6601223737): one live PayPal SANDBOX cross-currency capture, recorded to
// fixtures/paypal/orders/cross-currency/ through the product adapters (create → confirm the sandbox
// card → capture → capture GET). The order is in EUR, a currency the sandbox merchant does not hold,
// so PayPal converts and reports `seller_receivable_breakdown.exchange_rate`.
//
//   pnpm tsx scripts/spikes/bl01-cross-currency.ts   (run under the WORKFLOW.md live-lines launcher)
//
// One flow, never retried with other credentials. Synthetic workspace id (no database). Reads
// PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment and never prints them.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createOwnedTestPayment,
  createPayPalCapturesClient,
  createPayPalOrdersClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
  type TokenCache,
} from "../../packages/adapters/src/index.ts";
import { createRecorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../../packages/adapters/src/testing/scrub.ts";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing ${name} in the environment`);
  return v;
}

async function main(): Promise<void> {
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({ secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens] });
  const dir = fileURLToPath(new URL("../../fixtures/paypal/", import.meta.url));
  const recorder = createRecorder({ dir, ticket: "BL-01", scrubber });
  const debugIds: string[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      const id = e.response.headers["paypal-debug-id"];
      if (id !== undefined) debugIds.push(`${e.request.method} ${String(e.response.status)} ${id}`);
      recorder.onExchange(e);
    },
  });
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache: new Map() satisfies TokenCache });
  recorder.label("oauth/token-bl01-scratch");
  liveTokens.add((await tokens.getToken()).value);

  const orders = createPayPalOrdersClient({ http, tokens });
  const label = (name: string, note?: string): void => recorder.label(`orders/cross-currency/${name}`, note);
  const wrapped = {
    createOrder: (i: Parameters<typeof orders.createOrder>[0]) => {
      label("create", "BL-01: EUR order to the USD sandbox merchant; custom_id = synthetic workspace uuid");
      return orders.createOrder(i);
    },
    confirmCard: (...a: Parameters<typeof orders.confirmCard>) => {
      label("confirm", "confirm-payment-source with the sandbox test Visa");
      return orders.confirmCard(...a);
    },
    captureOrder: (...a: Parameters<typeof orders.captureOrder>) => {
      label("capture", "BL-01: cross-currency capture");
      return orders.captureOrder(...a);
    },
  };
  const out = await createOwnedTestPayment(
    { orders: wrapped, claimOrder: () => Promise.resolve() },
    { workspaceId: randomUUID(), requestId: randomUUID(), amount: { currency_code: "EUR", value: "42.00" } },
  );
  label("get-capture", "BL-01: capture GET right after the cross-currency flow");
  const got = await createPayPalCapturesClient({ http, tokens }).getCapture(out.captureId);
  console.log(JSON.stringify({ out, mirror: got.mirror, debugIds }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
