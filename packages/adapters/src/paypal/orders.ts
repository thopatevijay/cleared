// Typed PayPal client for Orders v2, Payments v2 captures, Orders v2 tracking and the legacy
// /v1/shipping trackers. Our own client, not @paypal/paypal-server-sdk: see ADR 0011 addendum
// (2026-10-29). Every call runs through the shared HTTP client and the one token provider.
import type { z } from "zod";
import type { HttpClient, HttpMethod } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";
import {
  CaptureSchema,
  LegacyTrackerSchema,
  OAuthErrorBodySchema,
  OrderSchema,
  PayPalErrorBodySchema,
  TrackersBatchResponseSchema,
  type Capture,
  type LegacyTracker,
  type Money,
  type Order,
  type PayPalErrorBody,
  type TrackersBatchResponse,
} from "./schemas.ts";
import type { TokenProvider } from "./token.ts";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

/** A non-2xx PayPal answer with its parsed error body (name, details, debug id). */
export class PayPalApiError extends HttpStatusError {
  readonly paypal: PayPalErrorBody | undefined;

  constructor(cause: HttpStatusError) {
    super(cause.vendor, cause.method, cause.url, cause.status, cause.bodyText, cause.headers, cause.debugId);
    this.name = "PayPalApiError";
    this.paypal = parseErrorBody(cause.bodyText);
  }
}

function parseErrorBody(text: string): PayPalErrorBody | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const api = PayPalErrorBodySchema.safeParse(json);
  if (api.success) return api.data;
  const oauth = OAuthErrorBodySchema.safeParse(json);
  return oauth.success ? { name: oauth.data.error, message: oauth.data.error_description } : undefined;
}

export interface CardSource {
  readonly number: string;
  readonly expiry: string;
  readonly securityCode: string;
  readonly name: string;
}

export interface CreateOrderInput {
  readonly amount: Money;
  /** = the owning workspace id in the product (`paypal_resource_owner`). */
  readonly customId: string;
  readonly referenceId?: string;
  readonly description?: string;
  readonly card: CardSource;
  /** `PayPal-Request-Id`: same id → PayPal replays the first result instead of a second order. */
  readonly requestId: string;
}

export interface TrackInput {
  readonly captureId: string;
  readonly trackingNumber: string;
  /** PayPal carrier code (e.g. `IND_DELHIVERY`) or `OTHER` with `carrierNameOther`. */
  readonly carrier: string;
  readonly carrierNameOther?: string;
  readonly notifyPayer?: boolean;
  readonly requestId: string;
}

export interface PayPalOrdersClient {
  createOrder(input: CreateOrderInput): Promise<Order>;
  captureOrder(orderId: string, requestId: string): Promise<Order>;
  getOrder(orderId: string): Promise<Order>;
  getCapture(captureId: string): Promise<Capture>;
  /** Orders v2 `POST /v2/checkout/orders/{id}/track` (201 + the order). */
  trackOrder(orderId: string, input: TrackInput): Promise<Order>;
  /** Legacy `POST /v1/shipping/trackers-batch`: status `COMPLETED`, no tracking number (services). */
  markCompleted(captureIds: readonly string[]): Promise<TrackersBatchResponse>;
  /** Legacy `GET /v1/shipping/trackers/{transaction_id}-{tracking_number|NOTRACKER}`. */
  getLegacyTracker(captureId: string, trackingNumber?: string): Promise<LegacyTracker>;
}

export interface PayPalOrdersClientOptions {
  readonly http: HttpClient;
  readonly tokens: TokenProvider;
  readonly baseUrl?: string;
}

interface CallOptions<S extends z.ZodType> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly schema: S;
  readonly body?: unknown;
  readonly requestId?: string;
  readonly representation?: boolean;
}

export function createPayPalOrdersClient(options: PayPalOrdersClientOptions): PayPalOrdersClient {
  const base = options.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;

  async function call<S extends z.ZodType>(o: CallOptions<S>): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.requestId !== undefined) headers["paypal-request-id"] = o.requestId;
    if (o.representation === true) headers.prefer = "return=representation";
    try {
      const res = await options.tokens.withToken((bearer) =>
        options.http.request({
          method: o.method,
          url: `${base}${o.path}`,
          headers: { ...headers, authorization: `Bearer ${bearer}` },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
          idempotent: o.method === "GET" || o.requestId !== undefined,
        }),
      );
      return o.schema.parse(JSON.parse(res.bodyText));
    } catch (err) {
      if (err instanceof HttpStatusError) throw new PayPalApiError(err);
      throw err;
    }
  }

  return {
    createOrder: (input) =>
      call({
        method: "POST",
        path: "/v2/checkout/orders",
        schema: OrderSchema,
        requestId: input.requestId,
        representation: true,
        body: {
          intent: "CAPTURE",
          purchase_units: [
            {
              ...(input.referenceId === undefined ? {} : { reference_id: input.referenceId }),
              ...(input.description === undefined ? {} : { description: input.description }),
              custom_id: input.customId,
              amount: input.amount,
            },
          ],
          payment_source: {
            card: {
              number: input.card.number,
              expiry: input.card.expiry,
              security_code: input.card.securityCode,
              name: input.card.name,
            },
          },
        },
      }),
    captureOrder: (orderId, requestId) =>
      call({
        method: "POST",
        path: `/v2/checkout/orders/${seg(orderId)}/capture`,
        schema: OrderSchema,
        requestId,
        representation: true,
        body: {},
      }),
    getOrder: (orderId) => call({ method: "GET", path: `/v2/checkout/orders/${seg(orderId)}`, schema: OrderSchema }),
    getCapture: (captureId) =>
      call({ method: "GET", path: `/v2/payments/captures/${seg(captureId)}`, schema: CaptureSchema }),
    trackOrder: (orderId, input) =>
      call({
        method: "POST",
        path: `/v2/checkout/orders/${seg(orderId)}/track`,
        schema: OrderSchema,
        requestId: input.requestId,
        body: {
          capture_id: input.captureId,
          tracking_number: input.trackingNumber,
          carrier: input.carrier,
          ...(input.carrierNameOther === undefined ? {} : { carrier_name_other: input.carrierNameOther }),
          notify_payer: input.notifyPayer ?? false,
        },
      }),
    markCompleted: (captureIds) =>
      call({
        method: "POST",
        path: "/v1/shipping/trackers-batch",
        schema: TrackersBatchResponseSchema,
        body: { trackers: captureIds.map((id) => ({ transaction_id: id, status: "COMPLETED" })) },
      }),
    getLegacyTracker: (captureId, trackingNumber) =>
      call({
        method: "GET",
        path: `/v1/shipping/trackers/${seg(`${captureId}-${trackingNumber ?? "NOTRACKER"}`)}`,
        schema: LegacyTrackerSchema,
      }),
  };
}

/** PayPal ids are [A-Z0-9-]; anything else is a bug or an injection attempt. */
function seg(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid PayPal id segment: ${JSON.stringify(id)}`);
  return id;
}

/** The first capture of the first purchase unit, if the order has been captured. */
export function firstCapture(order: Order): Capture | undefined {
  return order.purchase_units[0]?.payments?.captures?.[0];
}
