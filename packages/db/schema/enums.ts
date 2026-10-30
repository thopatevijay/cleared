// Postgres enums for Cleared's own states, built from the `@cleared/core` tuples (M1-01).
// PayPal-mirrored values (capture status/reason, dispute status/stage, hold reason) are `text`, never an
// enum: an unknown PayPal value must be stored verbatim (`Mirrored<T>` / `mirroredRaw`).
import {
  ACTION_KINDS,
  ACTION_RISKS,
  ACTION_STATES,
  AUDIT_ACTORS,
  DRAFT_STATES,
  EVIDENCE_KINDS,
  HOLD_STATES,
  LOCALES,
  PACK_STATES,
  PAYPAL_RESOURCE_TYPES,
  SYNC_SOURCES,
  VERDICTS,
  WORKSPACE_KINDS,
} from "@cleared/core";
import { pgEnum } from "drizzle-orm/pg-core";

/** Ingest status of a raw webhook row (M1-04). Platform-only, so it lives here, not in the core. */
export const WEBHOOK_EVENT_STATUSES = ["received", "processed", "quarantined", "failed"] as const;
export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

export const workspaceKind = pgEnum("workspace_kind", WORKSPACE_KINDS);
export const sessionKind = pgEnum("session_kind", WORKSPACE_KINDS);
export const locale = pgEnum("locale", LOCALES);
export const syncSource = pgEnum("sync_source", SYNC_SOURCES);
export const paypalResourceType = pgEnum("paypal_resource_type", PAYPAL_RESOURCE_TYPES);
export const webhookEventStatus = pgEnum("webhook_event_status", WEBHOOK_EVENT_STATUSES);
export const packState = pgEnum("pack_state", PACK_STATES);
export const evidenceKind = pgEnum("evidence_kind", EVIDENCE_KINDS);
export const verdict = pgEnum("verdict", VERDICTS);
export const holdState = pgEnum("hold_state", HOLD_STATES);
export const draftState = pgEnum("draft_state", DRAFT_STATES);
export const actionState = pgEnum("action_state", ACTION_STATES);
export const actionKind = pgEnum("action_kind", ACTION_KINDS);
export const actionRisk = pgEnum("action_risk", ACTION_RISKS);
export const auditActor = pgEnum("audit_actor", AUDIT_ACTORS);
