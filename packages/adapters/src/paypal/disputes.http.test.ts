// The dispute reads on the shared HTTP client (M2-06 AC): a 500 then 200 on the GET is retried; a 404 is
// not retried and does not count toward the circuit breaker. Bodies are the recorded M0-05 responses.
import { describe, expect, it } from "vitest";
import { loadFixture, responseText } from "../testing/fixture.ts";
import { createHttpClient } from "../http/client.ts";
import { createPayPalDisputesClient } from "./disputes.ts";
import { PayPalApiError } from "./orders.ts";
import type { TokenProvider } from "./token.ts";

const waiting = loadFixture("paypal/disputes/full/state-3-waiting_for_seller_response");
const DISPUTE_ID = "PP-R-UVC-10195076";

const tokens: TokenProvider = {
  getToken: () =>
    Promise.resolve({ value: "t", expiresAt: Date.now() + 60_000, scopes: [], appId: undefined }),
  invalidate: () => undefined,
  withToken: (call) => call("t"),
};

/** A client whose fetch answers from `script` in order and records every URL it was asked for. */
function scripted(script: readonly { status: number; body: string }[], threshold = 5) {
  const calls: string[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: 1_000,
    maxRetries: 2,
    log: false,
    sleep: () => Promise.resolve(),
    breaker: { threshold },
    fetch: (input) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const next = script[calls.length - 1];
      if (next === undefined) return Promise.reject(new Error("unexpected extra call"));
      return Promise.resolve(
        new Response(next.body, {
          status: next.status,
          headers: { "content-type": "application/json", "paypal-debug-id": "f00dfeed" },
        }),
      );
    },
  });
  return { dc: createPayPalDisputesClient({ http, tokens, env: () => "sandbox" }), http, calls };
}

describe("dispute GET on the shared HTTP client", () => {
  it("a 500 then a 200 is retried and parses the recorded dispute", async () => {
    const { dc, http, calls } = scripted([
      { status: 500, body: '{"name":"INTERNAL_SERVER_ERROR"}' },
      { status: 200, body: responseText(waiting) },
    ]);
    const d = await dc.getDispute(DISPUTE_ID);
    expect(calls).toHaveLength(2);
    expect(d.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(d.seller_response_due_date).toBe("2026-11-09T04:59:59.000Z");
    // the success closes the breaker again
    expect(http.breaker.state()).toBe("closed");
  });

  it("a 404 is not retried and does not trip the breaker (threshold 1)", async () => {
    const { dc, http, calls } = scripted(
      [{ status: 404, body: '{"name":"RESOURCE_NOT_FOUND","debug_id":"f00dfeed"}' }],
      1,
    );
    const err = await dc.getDispute("PP-R-NOPE-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).status).toBe(404);
    expect((err as PayPalApiError).debugId).toBe("f00dfeed");
    expect(calls).toHaveLength(1);
    expect(http.breaker.state()).toBe("closed");
  });

  it("a 500 on every attempt does trip it (the control for the 404 case)", async () => {
    const e500 = { status: 500, body: "{}" };
    const { dc, http, calls } = scripted([e500, e500, e500], 1);
    await expect(dc.getDispute(DISPUTE_ID)).rejects.toBeInstanceOf(Error);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(http.breaker.state()).toBe("open");
  });

  it("lists the disputes of one capture by disputed_transaction_id", async () => {
    const list = loadFixture("paypal/disputes/list/update-time-after");
    const { dc, calls } = scripted([{ status: 200, body: responseText(list) }]);
    const r = await dc.listDisputes({ disputedTransactionId: "794390931G848631R", updateTimeAfter: "x" });
    expect(r.items.length).toBeGreaterThan(0);
    const u = new URL(calls[0] ?? "");
    expect(u.pathname).toBe("/v1/customer/disputes");
    expect(u.searchParams.get("disputed_transaction_id")).toBe("794390931G848631R");
    expect(u.searchParams.has("update_time_after")).toBe(false);
  });

  it("refuses a capture id that is not a PayPal id segment before any call", async () => {
    const { dc, calls } = scripted([]);
    await expect(dc.listDisputes({ disputedTransactionId: "../x" })).rejects.toThrow(/invalid PayPal id/);
    expect(calls).toHaveLength(0);
  });
});
