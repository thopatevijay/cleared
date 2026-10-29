// Offline replay of the M0-04 live sandbox run (fixtures/paypal/). No network: unmatched requests fail.
import { afterEach, describe, expect, it } from "vitest";
import { createHttpClient, type HttpClient } from "../http/client.ts";
import { loadFixture } from "../testing/fixture.ts";
import { startReplay, type Replay } from "../testing/replay.ts";
import { createPayPalOrdersClient, firstCapture, PayPalApiError, type CreateOrderInput } from "./orders.ts";
import { createTokenProvider, hasScope, TRANSACTION_SEARCH_SCOPE, type TokenCache } from "./token.ts";

let replay: Replay | undefined;
afterEach(() => {
  replay?.close();
  replay = undefined;
});

function paypal(fixtures: string[]) {
  replay = startReplay(["paypal/oauth/token", ...fixtures]);
  const http: HttpClient = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0 });
  const cache: TokenCache = new Map();
  const tokens = createTokenProvider({
    http,
    baseUrl: "https://api-m.sandbox.paypal.com",
    credentials: { clientId: "replay", clientSecret: "replay" },
    cache,
  });
  return { pp: createPayPalOrdersClient({ http, tokens }), tokens, replay };
}

/** Rebuilds the create input from the recorded request so the PayPal-Request-Id matches. */
function createInput(name: string): CreateOrderInput {
  const f = loadFixture(name);
  const body = f.request.body as {
    purchase_units: {
      custom_id: string;
      reference_id: string;
      amount: { currency_code: string; value: string };
    }[];
  };
  const pu = body.purchase_units[0];
  if (pu === undefined) throw new Error("no purchase unit");
  return {
    amount: pu.amount,
    customId: pu.custom_id,
    referenceId: pu.reference_id,
    card: { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Replay" },
    requestId: f.request.headers["paypal-request-id"] ?? "",
  };
}

function trackerInput(name: string) {
  const f = loadFixture(name);
  const b = f.request.body as {
    capture_id: string;
    tracking_number: string;
    carrier: string;
    carrier_name_other?: string;
  };
  const orderId = /orders\/([^/]+)\/track$/.exec(f.request.url)?.[1] ?? "";
  return {
    orderId,
    input: {
      captureId: b.capture_id,
      trackingNumber: b.tracking_number,
      carrier: b.carrier,
      ...(b.carrier_name_other === undefined ? {} : { carrierNameOther: b.carrier_name_other }),
      requestId: f.request.headers["paypal-request-id"] ?? "",
    },
  };
}

describe("PayPal orders (replay of the recorded sandbox run)", () => {
  it("exposes the token scopes, including Transaction Search on the fresh app", async () => {
    const { tokens, replay: r } = paypal([]);
    const t = await tokens.getToken();
    expect(hasScope(t, TRANSACTION_SEARCH_SCOPE)).toBe(true);
    expect(hasScope(t, "https://uri.paypal.com/services/shipping/trackers/readwrite")).toBe(true);
    expect(r.unused()).toEqual([]);
  });

  it("create (card) + capture → COMPLETED with seller_receivable_breakdown and custom_id", async () => {
    const { pp, replay: r } = paypal(["paypal/orders/create-goods-a", "paypal/orders/get-capture-a"]);
    const input = createInput("paypal/orders/create-goods-a");
    const order = await pp.createOrder(input);
    expect(order.status).toBe("COMPLETED");
    const cap = firstCapture(order);
    expect(cap?.status).toBe("COMPLETED");
    expect(cap?.seller_receivable_breakdown?.gross_amount).toEqual({ currency_code: "USD", value: "42.00" });
    expect(cap?.seller_receivable_breakdown?.net_amount?.value).toBe("40.42");
    const got = await pp.getCapture(cap?.id ?? "");
    expect(got.custom_id).toBe(input.customId);
    expect(r.unused()).toEqual([]);
  });

  it("the same PayPal-Request-Id returns the same order id (idempotent replay)", async () => {
    const { pp } = paypal(["paypal/orders/create-goods-a", "paypal/orders/create-goods-a-replay"]);
    const input = createInput("paypal/orders/create-goods-a");
    const first = await pp.createOrder(input);
    const again = await pp.createOrder(input);
    expect(again.id).toBe(first.id);
    expect(firstCapture(again)?.id).toBe(firstCapture(first)?.id);
  });

  it("capturing an already-captured order is a 422 ORDER_ALREADY_CAPTURED", async () => {
    const { pp } = paypal(["paypal/errors/capture-already-captured"]);
    const f = loadFixture("paypal/errors/capture-already-captured");
    const orderId = /orders\/([^/]+)\/capture$/.exec(f.request.url)?.[1] ?? "";
    const err = (await pp
      .captureOrder(orderId, f.request.headers["paypal-request-id"] ?? "")
      .catch((e: unknown) => e)) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(422);
    expect(err.paypal?.details?.[0]?.issue).toBe("ORDER_ALREADY_CAPTURED");
  });

  it.each([
    ["listed carrier", "paypal/tracking/track-ind-delhivery", "IND_DELHIVERY"],
    ["OTHER + carrier_name_other", "paypal/tracking/track-other", "OTHER"],
  ])("track (%s) → 201 and a SHIPPED tracker", async (_l, name, carrier) => {
    const f = loadFixture(name);
    expect(f.response.status).toBe(201);
    const { pp, replay: r } = paypal([name]);
    const { orderId, input } = trackerInput(name);
    expect(input.carrier).toBe(carrier);
    const order = await pp.trackOrder(orderId, input);
    const tracker = order.purchase_units[0]?.shipping?.trackers?.[0];
    expect(tracker?.id).toBe(`${input.captureId}-${input.trackingNumber}`);
    expect(tracker?.status).toBe("SHIPPED");
    expect(r.unused()).toEqual([]);
  });

  it("trackers-batch COMPLETED (no tracking number) → read-back status COMPLETED", async () => {
    const { pp } = paypal(["paypal/tracking/trackers-batch-completed", "paypal/tracking/get-legacy-tracker"]);
    const body = loadFixture("paypal/tracking/trackers-batch-completed").request.body as {
      trackers: { transaction_id: string }[];
    };
    const captureId = body.trackers[0]?.transaction_id ?? "";
    const batch = await pp.markCompleted([captureId]);
    expect(batch.errors).toEqual([]);
    expect(batch.tracker_identifiers[0]?.transaction_id).toBe(captureId);
    const legacy = await pp.getLegacyTracker(captureId);
    expect(legacy.status).toBe("COMPLETED");
  });

  it("GET order mirrors the order status", async () => {
    const { pp } = paypal(["paypal/orders/get-order-a"]);
    const id = /orders\/([^/]+)$/.exec(loadFixture("paypal/orders/get-order-a").request.url)?.[1] ?? "";
    expect((await pp.getOrder(id)).status).toBe("COMPLETED");
  });

  it("400 validation error and 404 capture surface PayPal's name, details and debug id", async () => {
    const { pp } = paypal(["paypal/errors/400-validation", "paypal/errors/404-capture"]);
    const bad = {
      ...createInput("paypal/errors/400-validation"),
      amount: { currency_code: "USD", value: "forty-two" },
    };
    const e400 = (await pp.createOrder(bad).catch((e: unknown) => e)) as PayPalApiError;
    expect(e400.status).toBe(400);
    expect(e400.paypal?.name).toBe("INVALID_REQUEST");
    expect(e400.debugId).toMatch(/^[0-9a-f]+$/);
    const e404 = (await pp.getCapture("0NOTACAPTURE0000").catch((e: unknown) => e)) as PayPalApiError;
    expect(e404.status).toBe(404);
    expect(e404.paypal?.name).toBe("RESOURCE_NOT_FOUND");
  });

  it("a revoked token → 401 → one forced refresh → the call succeeds", async () => {
    const { pp, replay: r } = paypal([
      "paypal/errors/401-revoked-token",
      "paypal/errors/401-revoked-token.2",
      "paypal/errors/401-revoked-token.3",
    ]);
    const id = /orders\/([^/]+)$/.exec(loadFixture("paypal/errors/401-revoked-token").request.url)?.[1] ?? "";
    expect((await pp.getOrder(id)).status).toBe("COMPLETED");
    expect(r.unused()).toEqual([]);
  });

  it("an unrecorded request fails instead of reaching the network", async () => {
    const { pp } = paypal([]);
    await expect(pp.getOrder("NOTRECORDED1")).rejects.toThrow();
  });
});
