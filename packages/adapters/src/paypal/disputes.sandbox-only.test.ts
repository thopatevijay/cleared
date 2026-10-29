// processChargeback, requireEvidence and adjudicate exist only in PayPal's sandbox. They refuse,
// before any HTTP call, unless PAYPAL_ENV is exactly "sandbox" (and the base URL is the sandbox).
// The gate runs this file with PAYPAL_ENV=live; it passes the same way with the variable unset.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../http/client.ts";
import { createPayPalDisputesClient, SandboxOnlyError, type PayPalDisputesClient } from "./disputes.ts";
import type { TokenProvider } from "./token.ts";

function client(env?: () => string | undefined, baseUrl?: string): { dc: PayPalDisputesClient; calls: string[] } {
  const calls: string[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: 1_000,
    maxRetries: 0,
    fetch: (input) => {
      calls.push(String(input));
      return Promise.reject(new Error("no network in this test"));
    },
  });
  const tokens: TokenProvider = {
    getToken: () => Promise.resolve({ value: "t", expiresAt: Date.now() + 60_000, scopes: [], appId: undefined }),
    invalidate: () => undefined,
    withToken: (call) => call("t"),
  };
  const dc = createPayPalDisputesClient({ http, tokens, ...(env === undefined ? {} : { env }), ...(baseUrl === undefined ? {} : { baseUrl }) });
  return { dc, calls };
}

const calls = (dc: PayPalDisputesClient) => [
  () => dc.processChargeback({ captureId: "CAP1", amount: { currency_code: "USD", value: "1.00" }, merchantId: "M1", requestId: "r" }),
  () => dc.requireEvidence("PP-D-1", "SELLER_EVIDENCE", { requestId: "r" }),
  () => dc.adjudicate("PP-D-1", "SELLER_FAVOR", { requestId: "r" }),
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sandbox-only dispute calls", () => {
  it.each(["live", "production", "", undefined])("throw when PAYPAL_ENV is %j (explicit env)", async (value) => {
    const { dc, calls: http } = client(() => value);
    for (const run of calls(dc)) await expect(run()).rejects.toThrow(SandboxOnlyError);
    expect(http).toEqual([]);
  });

  it("read PAYPAL_ENV from the process at call time: live → throw", async () => {
    vi.stubEnv("PAYPAL_ENV", "live");
    const { dc, calls: http } = client();
    for (const run of calls(dc)) await expect(run()).rejects.toThrow(SandboxOnlyError);
    expect(http).toEqual([]);
  });

  it("follow the real process environment (the gate sets PAYPAL_ENV=live)", async () => {
    const { dc, calls: http } = client();
    if (process.env.PAYPAL_ENV === "sandbox") return; // nothing to refuse
    for (const run of calls(dc)) await expect(run()).rejects.toThrow(SandboxOnlyError);
    expect(http).toEqual([]);
  });

  it("throw with PAYPAL_ENV=sandbox but a non-sandbox base URL", async () => {
    const { dc, calls: http } = client(() => "sandbox", "https://api-m.paypal.com");
    for (const run of calls(dc)) await expect(run()).rejects.toThrow(SandboxOnlyError);
    expect(http).toEqual([]);
  });

  it("go through to PayPal when PAYPAL_ENV=sandbox", async () => {
    const { dc, calls: http } = client(() => "sandbox");
    await expect(calls(dc)[0]?.()).rejects.not.toThrow(SandboxOnlyError);
    expect(http).toEqual(["https://api-m.sandbox.paypal.com/v2/customer-support/process-chargeback"]);
  });
});
