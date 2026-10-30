// M1-04: record the owned test-payment flow (create → confirm card → capture) and capture GETs on the
// PayPal SANDBOX, through the product adapters, into fixtures/paypal/orders/test-payment/.
//
//   pnpm tsx --env-file=<path to .env> scripts/spikes/m1-04-test-payment.ts --record
//   pnpm tsx --env-file=<path to .env> scripts/spikes/m1-04-test-payment.ts --get <captureId> --name <fixture>
//
// The flow uses a synthetic workspace id (no database): `claimOrder` only records the call order so the
// output proves the owner is claimed before the capture. Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET
// from the environment and never prints them.
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
import { createRecorder, type Recorder } from "../../packages/adapters/src/testing/record.ts";
import { createScrubber } from "../../packages/adapters/src/testing/scrub.ts";

const TICKET = "M1-04";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing ${name} in the environment`);
  return v;
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  if ((process.env["PAYPAL_ENV"] ?? "sandbox") !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  const credentials = { clientId: env("PAYPAL_CLIENT_ID"), clientSecret: env("PAYPAL_CLIENT_SECRET") };
  const liveTokens = new Set<string>();
  const scrubber = createScrubber({
    secrets: () => [credentials.clientId, credentials.clientSecret, ...liveTokens],
  });
  const dir = fileURLToPath(new URL("../../fixtures/paypal/", import.meta.url));
  const recorder: Recorder | undefined =
    process.argv.includes("--record") || arg("--get") !== undefined
      ? createRecorder({ dir, ticket: TICKET, scrubber })
      : undefined;
  let calls = 0;
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => {
      calls += 1;
      recorder?.onExchange(e);
    },
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  recorder?.label("oauth/token-m1-04");
  liveTokens.add((await tokens.getToken()).value);

  const getId = arg("--get");
  if (getId !== undefined) {
    recorder?.label(`orders/${arg("--name") ?? `get-capture-${getId}`}`, "capture GET (M1-04 live proof)");
    const c = await createPayPalCapturesClient({ http, tokens }).getCapture(getId);
    console.log(JSON.stringify({ calls, capture: c.mirror }));
    return;
  }

  const orders = createPayPalOrdersClient({ http, tokens });
  const steps: string[] = [];
  const workspaceId = randomUUID();
  const requestId = randomUUID();
  const label = (name: string, note?: string): void => recorder?.label(`orders/test-payment/${name}`, note);
  const wrapped = {
    ...orders,
    createOrder: (i: Parameters<typeof orders.createOrder>[0]) => {
      steps.push("create");
      label("create", "no payment_source: the order stays CREATED; custom_id = synthetic workspace uuid");
      return orders.createOrder(i);
    },
    confirmCard: (...a: Parameters<typeof orders.confirmCard>) => {
      steps.push("confirm");
      label("confirm", "confirm-payment-source with the sandbox test Visa");
      return orders.confirmCard(...a);
    },
    captureOrder: (...a: Parameters<typeof orders.captureOrder>) => {
      steps.push("capture");
      label("capture");
      return orders.captureOrder(...a);
    },
  };
  const out = await createOwnedTestPayment(
    {
      orders: wrapped,
      claimOrder: (orderId) => {
        steps.push(`claim:${orderId}`);
        return Promise.resolve();
      },
    },
    { workspaceId, requestId },
  );
  label("get-capture", "capture GET right after the 3-step flow");
  const got = await createPayPalCapturesClient({ http, tokens }).getCapture(out.captureId);
  console.log(JSON.stringify({ calls, steps, workspaceId, requestId, out, mirror: got.mirror }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
