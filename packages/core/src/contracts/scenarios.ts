// M2-10 REST contract for the judge scenario (ADR 0003): GET /api/scenarios, POST /api/scenarios,
// GET /api/scenarios/:id, POST /api/scenarios/:id/decide. The web handlers build these; the client
// components parse them. Every PayPal state here is mirrored, never set by Cleared.
import { z } from "zod";
import { DECISION_BLOCKS, SCENARIO_STATES, TIMELINE_KEYS } from "../scenarios/judge-dispute.ts";

export const SCENARIO_UNAVAILABLE_REASONS = ["not_sandbox", "not_eligible", "llm_cap"] as const;
export type ScenarioUnavailableReason = (typeof SCENARIO_UNAVAILABLE_REASONS)[number];

export const TimelineStepSchema = z.object({
  key: z.enum(TIMELINE_KEYS),
  status: z.enum(["done", "active", "pending", "failed"]),
  at: z.string().nullable(),
  paypalIds: z.array(z.string()).readonly(),
  observed: z.string().nullable(),
});

export const ScenarioViewSchema = z.object({
  id: z.uuid(),
  state: z.enum(SCENARIO_STATES),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  failure: z.string().nullable(),
  timeline: z.array(TimelineStepSchema),
  dispute: z
    .object({
      disputeId: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      allowedActions: z.array(z.string()),
      outcome: z.object({ outcome_code: z.string(), outcome_reason: z.string().nullable() }).nullable(),
    })
    .nullable(),
  capture: z.object({ captureId: z.string(), status: z.string(), reason: z.string().nullable() }).nullable(),
  /** "payout_paypal_covered" only for RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL */
  outcome: z.enum(["payout_paypal_covered", "other"]).nullable(),
  /** the mirrored capture reads COMPLETED after the dispute resolved */
  holdReleased: z.boolean(),
  decision: z.object({
    shown: z.boolean(),
    enabled: z.boolean(),
    reason: z.enum(DECISION_BLOCKS).nullable(),
    requestedAt: z.string().nullable(),
    sentAt: z.string().nullable(),
    /** why the last sandbox decision call did not go through (ACTION_LINK_MISSING, PAYPAL_UNAVAILABLE, …) */
    error: z.string().nullable(),
  }),
  lastPolledAt: z.string().nullable(),
});
export type ScenarioView = z.infer<typeof ScenarioViewSchema>;

export const ScenarioIndexSchema = z.object({
  available: z.boolean(),
  reason: z.enum(SCENARIO_UNAVAILABLE_REASONS).nullable(),
  latest: z.object({ id: z.uuid(), state: z.enum(SCENARIO_STATES) }).nullable(),
});
export type ScenarioIndex = z.infer<typeof ScenarioIndexSchema>;
