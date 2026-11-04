// BL-01 (6488341912): one live PayPal SANDBOX Transaction Search call, recorded to
// fixtures/paypal/reporting/transactions-search.json through the shared HTTP client and token provider.
//
//   pnpm tsx scripts/spikes/bl01-txn-search.ts   (run under the WORKFLOW.md live-lines launcher)
//
// Read-only (GET), one search call, never retried with other credentials. Reads PAYPAL_CLIENT_ID /
// PAYPAL_CLIENT_SECRET from the environment and never prints them.
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  TRANSACTION_SEARCH_SCOPE,
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
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: VENDOR_TIMEOUTS_MS.paypal,
    onExchange: (e) => recorder.onExchange(e),
  });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials, cache });
  recorder.label("oauth/token-bl01-scratch");
  const token = await tokens.getToken();
  liveTokens.add(token.value);
  console.log(JSON.stringify({ hasSearchScope: token.scopes.includes(TRANSACTION_SEARCH_SCOPE) }));

  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const qs = new URLSearchParams({
    start_date: start.toISOString().replace(".000", ""),
    end_date: end.toISOString().replace(".000", ""),
    fields: "transaction_info",
    page_size: "5",
  });
  recorder.label("reporting/transactions-search", "BL-01: Transaction Search, last 7 days, page_size 5, one call");
  try {
    const res = await http.request({
      method: "GET",
      url: `${PAYPAL_SANDBOX_BASE_URL}/v1/reporting/transactions?${qs.toString()}`,
      headers: { accept: "application/json", authorization: `Bearer ${token.value}` },
    });
    console.log(JSON.stringify({ status: res.status, debugId: res.debugId, range: [qs.get("start_date"), qs.get("end_date")] }));
  } catch (err) {
    console.log(JSON.stringify({ failed: String(err), range: [qs.get("start_date"), qs.get("end_date")] }));
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
