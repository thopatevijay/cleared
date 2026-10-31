// Governance (ADR 0010): the agent only inserts proposed actions; approvals bind the payload sha256;
// executions carry a unique idempotency key; the audit log is append-only (trigger, migration 0002).
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { optionallyScoped, scoped } from "./accounts.ts";
import { agentRuns } from "./agent.ts";
import { sha256, tstz } from "./columns.ts";
import { actionKind, actionRisk, actionState, auditActor } from "./enums.ts";

export const proposedActions = pgTable(
  "proposed_actions",
  {
    ...scoped(),
    kind: actionKind("kind").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: sha256("payload_sha256").notNull(),
    state: actionState("state").notNull().default("proposed"),
    risk: actionRisk("risk").notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => agentRuns.id),
    /** M2-08: the seller-facing code of a `failed` action (core `ACTION_FAILURE_CODES`) */
    refusalCode: text("refusal_code"),
  },
  (t) => [index("proposed_actions_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);

export const approvals = pgTable(
  "approvals",
  {
    ...scoped(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => proposedActions.id),
    /** user id for sellers, or the demo session id (demo workspaces have no user) */
    approvedBy: text("approved_by").notNull(),
    approvedAt: tstz("approved_at").notNull().defaultNow(),
    payloadSha256: sha256("payload_sha256").notNull(),
  },
  (t) => [
    index("approvals_action_idx").on(t.actionId),
    index("approvals_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const executions = pgTable(
  "executions",
  {
    ...scoped(),
    actionId: uuid("action_id")
      .notNull()
      .references(() => proposedActions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    attempt: integer("attempt").notNull().default(1),
    paypalStatus: text("paypal_status"),
    paypalDebugId: text("paypal_debug_id"),
    response: jsonb("response"),
  },
  (t) => [
    uniqueIndex("executions_idempotency_key_key").on(t.idempotencyKey),
    index("executions_action_idx").on(t.actionId),
    index("executions_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    /** workspace_id is null for platform events with no workspace, e.g. a demo-cap refusal (M1-05) */
    ...optionallyScoped(),
    at: tstz("at").notNull().defaultNow(),
    actor: auditActor("actor").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);
