// POST /api/webhooks/paypal (M1-04, ADR 0012). Raw body (1 MB cap) → authenticate (self-verify, API
// fallback) → envelope → ONE transaction: the raw `webhook_events` row (ON CONFLICT DO NOTHING) and,
// only when this request inserted it and it is routable, the `paypal.capture.sync` job. 200 on insert
// and on a duplicate; no PayPal fetch inside the request. A rejected delivery → 401, nothing stored, a
// warning with the transmission id only.
import { randomUUID } from "node:crypto";
import {
  headerValue,
  PAYPAL_WEBHOOK_HEADERS,
  readRawBody,
  routeWebhook,
  withContext,
  WebhookEnvelopeSchema,
  type AuthResult,
  type Logger,
  type WebhookHeaders,
} from "@cleared/adapters";
import { PAYPAL_CAPTURE_SYNC_QUEUE, platform, withTransaction, type Db, type Publisher } from "@cleared/db";
import { apiError, CORRELATION_HEADER, json } from "../respond.ts";

export interface PayPalWebhookDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  /** null when PAYPAL_WEBHOOK_ID is not configured: every delivery is refused with 503. */
  readonly authenticate:
    ((input: { rawBody: string; headers: WebhookHeaders }) => Promise<AuthResult>) | null;
  readonly log: Logger;
  readonly now: () => Date;
}

/** The job payload: `eventId` is the `webhook_events.id` (uuid) the consumer marks processed. */
export interface CaptureSyncJob {
  readonly captureId: string;
  readonly eventId: string;
}

export type IngestOutcome = "stored" | "duplicate";

export async function postPayPalWebhook(req: Request, deps: PayPalWebhookDeps): Promise<Response> {
  const cid = randomUUID();
  const transmissionId = headerValue(req.headers, PAYPAL_WEBHOOK_HEADERS.transmissionId) ?? null;
  if (deps.authenticate === null) {
    deps.log.error({ transmissionId }, "paypal webhook refused: PAYPAL_WEBHOOK_ID not configured");
    return apiError(503, "not_configured", "Webhook verification is not configured.", cid);
  }
  const body = await readRawBody(req);
  if (!body.ok) return apiError(413, "payload_too_large", "The body exceeds 1 MB.", cid);
  const auth = await deps.authenticate({ rawBody: body.raw, headers: req.headers });
  if (!auth.ok) {
    deps.log.warn({ transmissionId, reason: auth.reason }, "paypal webhook rejected");
    const status = auth.reason === "api_verification_error" ? 503 : 401;
    return apiError(status, "unauthorized", "The webhook signature was not verified.", cid);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.raw);
  } catch {
    parsed = null;
  }
  const event = WebhookEnvelopeSchema.safeParse(parsed);
  if (!event.success) {
    deps.log.warn({ transmissionId }, "paypal webhook: verified but not an event envelope");
    return apiError(400, "invalid_event", "Not a PayPal event.", cid);
  }
  const outcome = await withContext({ correlationId: cid }, () =>
    withTransaction(deps.db, async (tx): Promise<IngestOutcome> => {
      const row = await platform(deps.db).webhookEvents.insertRaw(
        {
          provider: "paypal",
          eventId: event.data.id,
          type: event.data.event_type,
          raw: parsed,
          verified: true,
          receivedAt: deps.now(),
          correlationId: cid,
        },
        tx,
      );
      if (row === null) return "duplicate";
      const route = routeWebhook(event.data);
      if (route.kind === "capture_sync") {
        const job: CaptureSyncJob = { captureId: route.captureId, eventId: row.id };
        await deps.publisher.enqueue(tx, PAYPAL_CAPTURE_SYNC_QUEUE, job);
      }
      return "stored";
    }),
  );
  deps.log.info(
    { transmissionId, eventId: event.data.id, type: event.data.event_type, outcome, verify: auth.method },
    "paypal webhook acked",
  );
  return json({ received: true, outcome }, 200, { [CORRELATION_HEADER]: cid });
}
