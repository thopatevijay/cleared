// Platform tables: not workspace-scoped (webhook ingest, ownership, outbox, idempotency, consumers,
// worker readiness). Only `platform(db)` reads and writes them.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  smallint,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspaces } from "./accounts.ts";
import { createdAt, pk, sha256, tstz } from "./columns.ts";
import { paypalResourceType, webhookEventStatus } from "./enums.ts";

/** ADR 0008: written when Cleared creates the resource; children inherit the owner on ingest. */
export const paypalResourceOwner = pgTable(
  "paypal_resource_owner",
  {
    resourceType: paypalResourceType("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "paypal_resource_owner_pkey", columns: [t.resourceType, t.resourceId] }),
    index("paypal_resource_owner_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/** ADR 0012: raw row first (verified or not), dedupe on (provider, event_id). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: pk(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    raw: jsonb("raw").notNull(),
    verified: boolean("verified").notNull().default(false),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    status: webhookEventStatus("status").notNull().default("received"),
    processedAt: tstz("processed_at"),
    correlationId: text("correlation_id"),
    quarantineReason: text("quarantine_reason"),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_event_id_key").on(t.provider, t.eventId),
    index("webhook_events_status_received_idx").on(t.status, t.receivedAt),
  ],
);

/** ADR 0004: written in the state-change transaction; `payload` is a `DomainEvent`. */
export const outbox = pgTable(
  "outbox",
  {
    id: pk(),
    topic: text("topic").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    publishedAt: tstz("published_at"),
  },
  (t) => [
    index("outbox_unpublished_idx")
      .on(t.createdAt)
      .where(sql`${t.publishedAt} is null`),
  ],
);

/**
 * Mutating API routes: one response per (session, route, key). Anonymous routes (demo, magic link)
 * use a scope id derived from the client IP in `session_id` (M1-05).
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    sessionId: uuid("session_id").notNull(),
    route: text("route").notNull(),
    key: text("key").notNull(),
    responseHash: sha256("response_hash"),
    /** M1-05: the stored response a replay returns; null while the first request is in flight */
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "idempotency_keys_pkey", columns: [t.sessionId, t.route, t.key] }),
    index("idempotency_keys_created_idx").on(t.createdAt),
  ],
);

/** M1-03: an idempotent consumer records each message it has handled. */
export const consumerReceipts = pgTable(
  "consumer_receipts",
  {
    consumer: text("consumer").notNull(),
    messageId: text("message_id").notNull(),
    processedAt: tstz("processed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "consumer_receipts_pkey", columns: [t.consumer, t.messageId] })],
);

/** M1-08: readiness; one row per worker, upserted on every beat. */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  beatAt: tstz("beat_at").notNull(),
});

/** M2-02: operator switches, one row (`id = 1`). No row = every flag off. */
export const platformFlags = pgTable(
  "platform_flags",
  {
    id: smallint("id").primaryKey().default(1),
    /** with AGENT_KILL_SWITCH: blocks new agent runs, proposals and executions (ADR 0010) */
    agentKillSwitch: boolean("agent_kill_switch").notNull().default(false),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("platform_flags_single_row", sql`${t.id} = 1`)],
);

/**
 * M3-06: hits on a rate-limited anonymous route, one row per attempt, counted per bucket in a rolling
 * window (`ack:ip:<hmac>`, `ack:token:<sha256>`). Never a raw IP or token.
 */
export const rateLimitHits = pgTable(
  "rate_limit_hits",
  {
    id: pk(),
    bucket: text("bucket").notNull(),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [index("rate_limit_hits_bucket_at_idx").on(t.bucket, t.at)],
);

/**
 * M3-09: one row per measured check: the reconcile tick (`reconcile`), the SLO checks (`slo.*`) and the
 * synthetic judge path (`synthetic`, `synthetic.<step>`). `value`/`target` in the check's unit (seconds or
 * a count); null value = nothing to measure. Read by `/readyz` (last reconcile) and the runbook (M4-07).
 */
export const opsChecks = pgTable(
  "ops_checks",
  {
    id: pk(),
    runAt: tstz("run_at").notNull().defaultNow(),
    check: text("check").notNull(),
    value: numeric("value", { mode: "number" }),
    target: numeric("target", { mode: "number" }),
    pass: boolean("pass").notNull(),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("ops_checks_check_run_at_idx").on(t.check, t.runAt)],
);
