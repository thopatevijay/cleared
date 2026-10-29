// PayPal Webhooks Management v1 (https://developer.paypal.com/docs/api/webhooks/v1/) on the shared
// HTTP client and token provider: register / list / patch / delete the app's webhook, the webhook
// lookup (account-level events for the app), the simulator, the event list (back-fill) and the
// verify-signature postback (the fallback to self-verify, ADR 0012).
import { z } from "zod";
import type { HttpClient, HttpMethod } from "../http/client.ts";
import { HttpStatusError } from "../http/errors.ts";
import { PAYPAL_SANDBOX_BASE_URL, PayPalApiError } from "./orders.ts";
import type { TokenProvider } from "./token.ts";
import { headerValue, PAYPAL_WEBHOOK_HEADERS, type WebhookHeaders } from "./webhook-verify.ts";

/** The events Cleared subscribes to (ticket M0-06; PayPal event names, never invented). */
export const WEBHOOK_EVENT_TYPES = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.CAPTURE.REFUNDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const LinkSchema = z.object({ href: z.string(), rel: z.string(), method: z.string().optional() });

export const WebhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  event_types: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  links: z.array(LinkSchema).optional(),
});
export type Webhook = z.infer<typeof WebhookSchema>;
export const WebhookListSchema = z.object({ webhooks: z.array(WebhookSchema).default([]) });

export const WebhookLookupSchema = z.object({
  id: z.string(),
  client_id: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type WebhookLookup = z.infer<typeof WebhookLookupSchema>;
export const WebhookLookupListSchema = z.object({
  webhooks_lookups: z.array(WebhookLookupSchema).default([]),
});

export const WebhookEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  create_time: z.string(),
  resource_type: z.string().optional(),
  resource_version: z.string().optional(),
  summary: z.string().optional(),
  resource: z.unknown(),
  links: z.array(LinkSchema).optional(),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
export const WebhookEventListSchema = z.object({
  events: z.array(WebhookEventSchema).default([]),
  count: z.number().optional(),
  links: z.array(LinkSchema).optional(),
});
export type WebhookEventList = z.infer<typeof WebhookEventListSchema>;

export const VerifySignatureResponseSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});
export type VerificationStatus = z.infer<typeof VerifySignatureResponseSchema>["verification_status"];

export type EnsureAction = "created" | "patched" | "unchanged";

export interface ListWebhookEventsInput {
  readonly startTime?: string;
  readonly endTime?: string;
  readonly eventType?: string;
  readonly transactionId?: string;
  readonly pageSize?: number;
}

export interface SimulateEventInput {
  /** Delivers to this webhook's URL (signed with the literal id `WEBHOOK_ID`). */
  readonly webhookId?: string;
  readonly url?: string;
  readonly eventType: string;
  readonly resourceVersion?: string;
}

export interface PayPalWebhooksClient {
  listWebhooks(): Promise<Webhook[]>;
  /** List → create if no webhook has this exact URL → PATCH event types if they differ. Idempotent. */
  ensureWebhook(
    url: string,
    eventTypes: readonly string[],
  ): Promise<{ webhook: Webhook; action: EnsureAction }>;
  /** true when deleted, false when it was already gone (404). */
  deleteWebhook(id: string): Promise<boolean>;
  listWebhookLookups(): Promise<WebhookLookup[]>;
  /** Ties account-level events (not created through this app) to this app; one per app. */
  ensureWebhookLookup(): Promise<{ lookup: WebhookLookup; action: "created" | "unchanged" }>;
  simulateEvent(input: SimulateEventInput): Promise<WebhookEvent>;
  /** Replay / back-fill: events PayPal sent to this app's webhooks (M3-09). */
  listWebhookEvents(input?: ListWebhookEventsInput): Promise<WebhookEventList>;
  /** `POST /v1/notifications/verify-webhook-signature`, with the event spliced in exactly as received. */
  verifyViaApi(input: {
    rawBody: string | Uint8Array;
    headers: WebhookHeaders;
    webhookId: string;
  }): Promise<VerificationStatus>;
}

export interface PayPalWebhooksClientOptions {
  readonly http: HttpClient;
  readonly tokens: TokenProvider;
  readonly baseUrl?: string;
}

interface SendOptions<S extends z.ZodType> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly schema: S;
  /** Already-serialised JSON (so `verifyViaApi` can splice the raw event in). */
  readonly body?: string;
  readonly idempotent: boolean;
}

export function createPayPalWebhooksClient(options: PayPalWebhooksClientOptions): PayPalWebhooksClient {
  const base = options.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;

  async function send<S extends z.ZodType>(o: SendOptions<S>): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await options.tokens.withToken((bearer) =>
        options.http.request({
          method: o.method,
          url: `${base}${o.path}`,
          headers: { ...headers, authorization: `Bearer ${bearer}` },
          ...(o.body === undefined ? {} : { body: o.body }),
          idempotent: o.idempotent,
        }),
      );
      return o.schema.parse(res.bodyText.trim() === "" ? {} : JSON.parse(res.bodyText));
    } catch (err) {
      if (err instanceof HttpStatusError) throw new PayPalApiError(err);
      throw err;
    }
  }

  const listWebhooks = async (): Promise<Webhook[]> =>
    (
      await send({
        method: "GET",
        path: "/v1/notifications/webhooks",
        schema: WebhookListSchema,
        idempotent: true,
      })
    ).webhooks;
  const listWebhookLookups = async (): Promise<WebhookLookup[]> =>
    (
      await send({
        method: "GET",
        path: "/v1/notifications/webhooks-lookup",
        schema: WebhookLookupListSchema,
        idempotent: true,
      })
    ).webhooks_lookups;

  async function ensureWebhook(url: string, eventTypes: readonly string[]) {
    const wanted = [...new Set(eventTypes)].sort();
    const existing = (await listWebhooks()).find((w) => w.url === url);
    const body = (names: readonly string[]) => names.map((name) => ({ name }));
    if (existing === undefined) {
      const webhook = await send({
        method: "POST",
        path: "/v1/notifications/webhooks",
        schema: WebhookSchema,
        body: JSON.stringify({ url, event_types: body(wanted) }),
        idempotent: false,
      });
      return { webhook, action: "created" as const };
    }
    const have = existing.event_types.map((e) => e.name).sort();
    if (have.join(",") === wanted.join(",")) return { webhook: existing, action: "unchanged" as const };
    const webhook = await send({
      method: "PATCH",
      path: `/v1/notifications/webhooks/${seg(existing.id)}`,
      schema: WebhookSchema,
      body: JSON.stringify([{ op: "replace", path: "/event_types", value: body(wanted) }]),
      idempotent: true,
    });
    return { webhook, action: "patched" as const };
  }

  async function deleteWebhook(id: string): Promise<boolean> {
    try {
      await send({
        method: "DELETE",
        path: `/v1/notifications/webhooks/${seg(id)}`,
        schema: z.unknown(),
        idempotent: true,
      });
      return true;
    } catch (err) {
      if (err instanceof PayPalApiError && err.status === 404) return false;
      throw err;
    }
  }

  async function ensureWebhookLookup() {
    const [first] = await listWebhookLookups();
    if (first !== undefined) return { lookup: first, action: "unchanged" as const };
    const lookup = await send({
      method: "POST",
      path: "/v1/notifications/webhooks-lookup",
      schema: WebhookLookupSchema,
      body: "{}",
      idempotent: false,
    });
    return { lookup, action: "created" as const };
  }

  return {
    listWebhooks,
    ensureWebhook,
    deleteWebhook,
    listWebhookLookups,
    ensureWebhookLookup,
    simulateEvent: (input) =>
      send({
        method: "POST",
        path: "/v1/notifications/simulate-event",
        schema: WebhookEventSchema,
        body: JSON.stringify({
          ...(input.webhookId === undefined ? {} : { webhook_id: input.webhookId }),
          ...(input.url === undefined ? {} : { url: input.url }),
          event_type: input.eventType,
          ...(input.resourceVersion === undefined ? {} : { resource_version: input.resourceVersion }),
        }),
        idempotent: false,
      }),
    listWebhookEvents: (input = {}) =>
      send({
        method: "GET",
        path: `/v1/notifications/webhooks-events?${eventsQuery(input)}`,
        schema: WebhookEventListSchema,
        idempotent: true,
      }),
    verifyViaApi: async (input) =>
      (
        await send({
          method: "POST",
          path: "/v1/notifications/verify-webhook-signature",
          schema: VerifySignatureResponseSchema,
          body: verifyRequestBody(input),
          idempotent: true,
        })
      ).verification_status,
  };
}

function eventsQuery(input: ListWebhookEventsInput): string {
  const q = new URLSearchParams();
  q.set("page_size", String(input.pageSize ?? 50));
  if (input.startTime !== undefined) q.set("start_time", input.startTime);
  if (input.endTime !== undefined) q.set("end_time", input.endTime);
  if (input.eventType !== undefined) q.set("event_type", input.eventType);
  if (input.transactionId !== undefined) q.set("transaction_id", input.transactionId);
  return q.toString();
}

/**
 * The postback body. PayPal: "the webhook_event data [must] be posted back exactly as it was
 * received", so the raw body is spliced in as text, never parsed and re-serialised.
 */
export function verifyRequestBody(input: {
  rawBody: string | Uint8Array;
  headers: WebhookHeaders;
  webhookId: string;
}): string {
  const h = PAYPAL_WEBHOOK_HEADERS;
  const head = JSON.stringify({
    auth_algo: headerValue(input.headers, h.authAlgo) ?? "",
    cert_url: headerValue(input.headers, h.certUrl) ?? "",
    transmission_id: headerValue(input.headers, h.transmissionId) ?? "",
    transmission_sig: headerValue(input.headers, h.transmissionSig) ?? "",
    transmission_time: headerValue(input.headers, h.transmissionTime) ?? "",
    webhook_id: input.webhookId,
  });
  const raw = typeof input.rawBody === "string" ? input.rawBody : new TextDecoder().decode(input.rawBody);
  return `${head.slice(0, -1)},"webhook_event":${raw}}`;
}

/** PayPal ids are [A-Z0-9-]; anything else is a bug or an injection attempt. */
function seg(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid PayPal id segment: ${JSON.stringify(id)}`);
  return id;
}
