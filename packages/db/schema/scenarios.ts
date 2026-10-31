// M2-10: the judge dispute scenario. One row per run; the step jobs move `state` (core `advance`) and keep
// the real PayPal ids per step in `steps`. At most one active run per workspace (partial unique index).
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { tstz } from "./columns.ts";

export const scenarioRuns = pgTable(
  "scenario_runs",
  {
    ...scoped(),
    kind: text("kind").notNull().default("judge_dispute"),
    /** core SCENARIO_STATES */
    state: text("state").notNull().default("capturing"),
    orderId: text("order_id"),
    captureId: text("capture_id"),
    disputeId: text("dispute_id"),
    /** core `ScenarioSteps`: per-step facts with PayPal ids and times */
    steps: jsonb("steps").notNull().default({}),
    pollStartedAt: tstz("poll_started_at"),
    lastPolledAt: tstz("last_polled_at"),
    polls: integer("polls").notNull().default(0),
    decisionRequestedAt: tstz("decision_requested_at"),
    decisionSentAt: tstz("decision_sent_at"),
    /** why the sandbox decision call did not go through (e.g. `ACTION_LINK_MISSING`), else null */
    decisionError: text("decision_error"),
    finishedAt: tstz("finished_at"),
    /** why a run ended `failed` / `timed_out` */
    failure: text("failure"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "scenario_runs_state_check",
      sql`${t.state} in ('capturing','seeding','charging_back','polling','resolved','timed_out','failed')`,
    ),
    uniqueIndex("scenario_runs_one_active_key")
      .on(t.workspaceId)
      .where(sql`${t.state} in ('capturing','seeding','charging_back','polling')`),
    index("scenario_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("scenario_runs_dispute_idx").on(t.disputeId),
  ],
);
