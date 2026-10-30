// Webhook ingest, the vendor half (M1-04, ADR 0012). Reads the raw body under a cap, authenticates the
// delivery (self-verify; the verify-signature postback only when self-verify is inconclusive), parses
// the event envelope and decides its route. No database here: the web app writes the raw row and the
// job in one transaction. Evidence of the SSRF guard: a cert URL that fails `checkCertUrl`, or that is
// not the sandbox host while running against the sandbox, is refused before any network call.
import { z } from "zod";
import {
  checkCertUrl,
  headerValue,
  PAYPAL_WEBHOOK_HEADERS,
  type WebhookHeaders,
  type WebhookVerifier,
  type WebhookVerifyFailure,
} from "./webhook-verify.ts";
import { WEBHOOK_EVENT_TYPES, type PayPalWebhooksClient, type VerificationStatus } from "./webhooks.ts";

/** 1 MB: PayPal events are a few KB; anything larger is refused before it is buffered. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export type PayPalEnv = "sandbox" | "live";
/** The only cert host accepted per environment (sandbox deliveries never come from the live host). */
export const CERT_HOST_BY_ENV: Readonly<Record<PayPalEnv, string>> = {
  sandbox: "api.sandbox.paypal.com",
  live: "api.paypal.com",
};

export type RawBodyResult =
  { readonly ok: true; readonly raw: string } | { readonly ok: false; readonly reason: "too_large" };

/** Reads the request body as received (UTF-8 text, never re-serialised), refusing more than `max` bytes. */
export async function readRawBody(req: Request, max = MAX_WEBHOOK_BODY_BYTES): Promise<RawBodyResult> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) return { ok: false, reason: "too_large" };
  if (req.body === null) return { ok: true, raw: "" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) return { ok: false, reason: "too_large" };
    chunks.push(chunk);
  }
  return { ok: true, raw: new TextDecoder().decode(Buffer.concat(chunks)) };
}

export type AuthFailure =
  WebhookVerifyFailure | "cert_host_wrong_env" | "api_verification_failed" | "api_verification_error";

export type AuthResult =
  | { readonly ok: true; readonly method: "self" | "api" }
  | { readonly ok: false; readonly reason: AuthFailure };

export interface WebhookAuthenticatorOptions {
  readonly verifier: WebhookVerifier;
  /** The postback (`PayPalWebhooksClient.verifyViaApi`). */
  readonly verifyViaApi: (input: {
    rawBody: string;
    headers: WebhookHeaders;
    webhookId: string;
  }) => Promise<VerificationStatus>;
  /** Our webhook's id (`PAYPAL_WEBHOOK_ID`). Never special-cased to `WEBHOOK_ID` (BL-01 6489621772). */
  readonly webhookId: string;
  readonly env: PayPalEnv;
}

/** Self-verify results that say nothing about the signature itself: only these fall back to the API. */
const INCONCLUSIVE: readonly WebhookVerifyFailure[] = ["cert_fetch_failed", "unsupported_algo"];

export function createWebhookAuthenticator(o: WebhookAuthenticatorOptions) {
  return async function authenticate(input: {
    rawBody: string;
    headers: WebhookHeaders;
  }): Promise<AuthResult> {
    const certUrl = headerValue(input.headers, PAYPAL_WEBHOOK_HEADERS.certUrl);
    if (certUrl !== undefined) {
      const check = checkCertUrl(certUrl);
      if (!check.ok) return { ok: false, reason: check.reason };
      if (new URL(check.url).hostname !== CERT_HOST_BY_ENV[o.env]) {
        return { ok: false, reason: "cert_host_wrong_env" };
      }
    }
    const self = await o.verifier.verifyWebhook({ ...input, webhookId: o.webhookId });
    if (self.ok) return { ok: true, method: "self" };
    if (!INCONCLUSIVE.includes(self.reason)) return { ok: false, reason: self.reason };
    try {
      const status = await o.verifyViaApi({ ...input, webhookId: o.webhookId });
      return status === "SUCCESS"
        ? { ok: true, method: "api" }
        : { ok: false, reason: "api_verification_failed" };
    } catch {
      return { ok: false, reason: "api_verification_error" };
    }
  };
}

/** The event envelope PayPal posts (Webhooks v1 event). `resource` stays opaque until routed. */
export const WebhookEnvelopeSchema = z.object({
  id: z.string().min(1).max(128),
  event_type: z.string().min(1).max(128),
  resource_type: z.string().max(64).optional(),
  resource_version: z.string().max(16).optional(),
  create_time: z.string().min(1),
  resource: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

export type WebhookRoute =
  | {
      readonly kind: "capture_sync";
      readonly captureId: string;
      /**
       * true for PAYMENT.CAPTURE.* (the sync marks the event processed). false for CUSTOMER.DISPUTE.*:
       * the disputed capture is re-fetched (a chargeback hold arrives with no PAYMENT.CAPTURE.PENDING,
       * BL-01 6489621553) but the event stays `received` for M2-06's dispute routing.
       */
      readonly marksEvent: boolean;
    }
  /** Stored raw with status `received` (orders, unknown types: M2-06), or an event with no capture id. */
  | { readonly kind: "store_only" };

/** PAYMENT.CAPTURE.* events that re-fetch a capture (PayPal event names, never invented). */
export const CAPTURE_EVENT_TYPES = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;
const REFUND_LIKE = new Set(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);

const CAPTURE_ID = /^[A-Z0-9]{6,32}$/;
const CAPTURE_HREF = /\/v[12]\/payments\/captures?\/([A-Z0-9]{6,32})(?:[/?#]|$)/;

const LinksSchema = z.array(z.object({ href: z.string(), rel: z.string() }).loose());

function linkCapture(resource: Record<string, unknown>, rels: readonly string[]): string | null {
  const links = LinksSchema.safeParse(resource["links"]);
  if (!links.success) return null;
  for (const rel of rels) {
    for (const l of links.data) {
      const m = l.rel === rel ? CAPTURE_HREF.exec(l.href) : null;
      if (m?.[1] !== undefined) return m[1];
    }
  }
  return null;
}

/**
 * The capture a PAYMENT.CAPTURE.* event is about: `resource.id` for a capture resource; for a refund
 * or reversal resource the `rel=up` link (v2), else the v1 `capture` link or `capture_id`.
 */
export function captureIdOf(eventType: string, resource: Record<string, unknown>): string | null {
  if (REFUND_LIKE.has(eventType)) {
    const fromLink = linkCapture(resource, ["up", "capture"]);
    if (fromLink !== null) return fromLink;
    const v1 = resource["capture_id"];
    return typeof v1 === "string" && CAPTURE_ID.test(v1) ? v1 : null;
  }
  const id = resource["id"];
  return typeof id === "string" && CAPTURE_ID.test(id) ? id : null;
}

/** The route every environment registers: `<web base URL>/api/webhooks/paypal`. */
export const WEBHOOK_PATH = "/api/webhooks/paypal";

export function webhookUrlFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.protocol !== "https:") throw new Error("PayPal delivers webhooks to https URLs only");
  return `${u.origin}${WEBHOOK_PATH}`;
}

export interface WebhookSetupResult {
  readonly url: string;
  readonly webhookId: string;
  readonly webhook: "created" | "patched" | "unchanged";
  readonly lookupId: string;
  readonly lookup: "created" | "unchanged";
}

/**
 * `scripts/setup.ts` (M1-04): idempotent. The app's webhook for `<baseUrl>/api/webhooks/paypal` with
 * `WEBHOOK_EVENT_TYPES` (created once, patched when the event types drift), then the webhook lookup.
 */
export async function setupAppWebhook(
  wh: Pick<PayPalWebhooksClient, "ensureWebhook" | "ensureWebhookLookup">,
  baseUrl: string,
): Promise<WebhookSetupResult> {
  const url = webhookUrlFor(baseUrl);
  const { webhook, action } = await wh.ensureWebhook(url, WEBHOOK_EVENT_TYPES);
  const { lookup, action: lookupAction } = await wh.ensureWebhookLookup();
  return { url, webhookId: webhook.id, webhook: action, lookupId: lookup.id, lookup: lookupAction };
}

const DisputedCaptureSchema = z.object({
  disputed_transactions: z
    .array(z.object({ seller_transaction_id: z.string().regex(CAPTURE_ID).optional() }).loose())
    .min(1),
});

/** The capture a CUSTOMER.DISPUTE.* event is about: `disputed_transactions[0].seller_transaction_id`. */
export function disputedCaptureIdOf(resource: Record<string, unknown>): string | null {
  const parsed = DisputedCaptureSchema.safeParse(resource);
  return parsed.success ? (parsed.data.disputed_transactions[0]?.seller_transaction_id ?? null) : null;
}

export function routeWebhook(event: WebhookEnvelope): WebhookRoute {
  if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
    const captureId = disputedCaptureIdOf(event.resource);
    return captureId === null
      ? { kind: "store_only" }
      : { kind: "capture_sync", captureId, marksEvent: false };
  }
  if (!(CAPTURE_EVENT_TYPES as readonly string[]).includes(event.event_type)) return { kind: "store_only" };
  const captureId = captureIdOf(event.event_type, event.resource);
  return captureId === null ? { kind: "store_only" } : { kind: "capture_sync", captureId, marksEvent: true };
}
