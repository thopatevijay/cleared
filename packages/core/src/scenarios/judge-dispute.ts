// The judge dispute scenario (M2-10), as a pure step machine. A demo (or owner) workspace runs one real
// sandbox path end to end: card capture → seed the proof pack → sandbox chargeback → targeted poll until
// PayPal reaches a terminal state. Each step is one worker job; a job only acts when the run is in that
// step's state, so a re-delivered job is a no-op. PayPal states are never invented here: the poll
// observes them and the outcome is read from the mirror (CLAUDE.md "Domain rules").
import { z } from "zod";

export const SCENARIO_STATES = [
  "capturing",
  "seeding",
  "charging_back",
  "polling",
  "resolved",
  "timed_out",
  "failed",
] as const;
export type ScenarioState = (typeof SCENARIO_STATES)[number];

/** At most one run per workspace is in one of these (unique partial index on `scenario_runs`). */
export const SCENARIO_ACTIVE_STATES = [
  "capturing",
  "seeding",
  "charging_back",
  "polling",
] as const satisfies readonly ScenarioState[];

export const SCENARIO_STEPS = ["capture", "seed_pack", "chargeback", "poll"] as const;
export type ScenarioStep = (typeof SCENARIO_STEPS)[number];

/** The state a step's job runs in, and the state its success moves the run to. */
export const SCENARIO_STEP_STATES: Readonly<
  Record<ScenarioStep, { from: ScenarioState; to: ScenarioState }>
> = {
  capture: { from: "capturing", to: "seeding" },
  seed_pack: { from: "seeding", to: "charging_back" },
  chargeback: { from: "charging_back", to: "polling" },
  // the poll's own exit is `pollVerdict`; `to` is where a continuing poll stays
  poll: { from: "polling", to: "polling" },
};

/** The scenario's payment: one card capture of $120.00 USD (the design's synthetic "logo redesign"). */
export const SCENARIO_AMOUNT = { currency_code: "USD", value: "120.00" } as const;
export const SCENARIO_POLL_INTERVAL_MS = 30_000;
/** The poll gives up 60 minutes after the chargeback (M0-05 measured ≈ 21.5 min end to end). */
export const SCENARIO_POLL_LIMIT_MS = 60 * 60_000;
/** An active run older than this has lost its job chain (dead-lettered); a new start may close it. */
export const SCENARIO_STALE_MS = SCENARIO_POLL_LIMIT_MS + 15 * 60_000;

/**
 * Expected waits shown on the timeline, from the M0-05 spike (2026-10-29): the evidence step opened at
 * +3 min 35 s, `adjudicate` appeared ≈ 3.5 min after evidence, RESOLVED ≈ 6.5 min after the decision.
 * The copy rounds them up (dispute-review.md: "usually within ~15 min").
 */
export const SCENARIO_EXPECTED_WAIT_MIN = { evidenceStep: 15, decisionStep: 5, outcome: 10 } as const;

export function isScenarioActive(state: ScenarioState): boolean {
  return (SCENARIO_ACTIVE_STATES as readonly ScenarioState[]).includes(state);
}

/**
 * The state after `step` succeeds, or null when the run is not in that step's state (a re-delivered or
 * stale job: do nothing, call nothing).
 */
export function advance(state: ScenarioState, step: ScenarioStep): ScenarioState | null {
  const s = SCENARIO_STEP_STATES[step];
  return state === s.from ? s.to : null;
}

/**
 * The `PayPal-Request-Id` root per step, stable per run. Orders v2 replays the first result for a repeated
 * id (M0-04); Disputes v1 does not (M0-05), so the chargeback is also guarded by a list-before-create.
 */
export function scenarioRequestIds(runId: string) {
  return { payment: runId, chargeback: `${runId}-chargeback`, decide: `${runId}-decide` } as const;
}

/** Per-step facts kept on the run (`scenario_runs.steps`): real PayPal ids and when each step finished. */
export const ScenarioStepsSchema = z.object({
  capture: z
    .object({
      at: z.string(),
      orderId: z.string(),
      captureId: z.string(),
      status: z.string(),
      /** the order's `payee.merchant_id`, for the sandbox chargeback */
      merchantId: z.string().nullable(),
    })
    .optional(),
  seed_pack: z
    .object({ at: z.string(), packId: z.string(), evidenceItemIds: z.array(z.string()) })
    .optional(),
  chargeback: z.object({ at: z.string(), disputeId: z.string(), adopted: z.boolean() }).optional(),
  poll: z
    .object({
      at: z.string(),
      count: z.number().int().nonnegative(),
      disputeStatus: z.string().nullable(),
      captureStatus: z.string().nullable(),
      captureReason: z.string().nullable(),
    })
    .optional(),
  /**
   * Milestones as PayPal first showed them, recorded by the poll at that moment (never re-derived from
   * the current state, so each timeline step keeps the time and status it was observed with).
   */
  seen: z
    .object({
      evidence_step: z.object({ at: z.string(), status: z.string() }).optional(),
      decision_offered: z.object({ at: z.string() }).optional(),
      hold: z.object({ at: z.string(), status: z.string() }).optional(),
      resolved: z.object({ at: z.string(), outcomeCode: z.string().nullable() }).optional(),
      released: z.object({ at: z.string(), status: z.string() }).optional(),
    })
    .optional(),
});
export type ScenarioSteps = z.infer<typeof ScenarioStepsSchema>;
export type ScenarioSeen = NonNullable<ScenarioSteps["seen"]>;

export interface PollSnapshot {
  readonly disputeStatus: string | null;
  readonly allowedActions: readonly string[];
  readonly outcomeCode: string | null;
  readonly captureStatus: string | null;
  readonly captureReason: string | null;
}

const withReason = (status: string, reason: string | null): string =>
  reason === null ? status : `${status} / ${reason}`;

/** Adds the milestones this poll observed for the first time; earlier records are never rewritten. */
export function recordMilestones(seen: ScenarioSeen, o: PollSnapshot, at: string): ScenarioSeen {
  const next: { -readonly [K in keyof ScenarioSeen]: ScenarioSeen[K] } = { ...seen };
  const evidenceOpen =
    o.disputeStatus === "WAITING_FOR_SELLER_RESPONSE" || o.allowedActions.includes("provide_evidence");
  if (next.evidence_step === undefined && evidenceOpen && o.disputeStatus !== null) {
    next.evidence_step = { at, status: o.disputeStatus };
  }
  if (next.decision_offered === undefined && o.allowedActions.includes("adjudicate")) {
    next.decision_offered = { at };
  }
  if (next.hold === undefined && o.captureStatus === "PENDING") {
    next.hold = { at, status: withReason(o.captureStatus, o.captureReason) };
  }
  if (next.resolved === undefined && o.disputeStatus === "RESOLVED") {
    next.resolved = { at, outcomeCode: o.outcomeCode };
  }
  if (next.released === undefined && next.hold !== undefined && o.captureStatus === "COMPLETED") {
    next.released = { at, status: o.captureStatus };
  }
  return next;
}

export interface PollObservation {
  readonly disputeStatus: string | null;
  readonly captureStatus: string | null;
}

export type PollVerdict = "continue" | "resolved" | "timed_out";

/** Terminal: PayPal resolved the dispute and the capture is no longer held. */
export function isTerminal(o: PollObservation): boolean {
  return o.disputeStatus === "RESOLVED" && o.captureStatus !== null && o.captureStatus !== "PENDING";
}

/** Whether the poll should stop: terminal state, or 60 minutes since the chargeback. */
export function pollVerdict(startedAtMs: number, nowMs: number, o: PollObservation): PollVerdict {
  if (isTerminal(o)) return "resolved";
  return nowMs - startedAtMs >= SCENARIO_POLL_LIMIT_MS ? "timed_out" : "continue";
}

/** True when the poll may not even run: the run is already past its 60-minute window. */
export function pollExpired(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs >= SCENARIO_POLL_LIMIT_MS;
}

/** An active run whose job chain died (e.g. dead-lettered); starting a new run closes it as timed out. */
export function isStaleRun(state: ScenarioState, createdAtMs: number, nowMs: number): boolean {
  return isScenarioActive(state) && nowMs - createdAtMs >= SCENARIO_STALE_MS;
}

// ---- the sandbox decision control -----------------------------------------------------------------

export const DECISION_BLOCKS = [
  "not_sandbox",
  "no_dispute",
  "not_owned",
  "finished",
  "already_requested",
  "evidence_not_filed",
  "no_adjudicate_link",
] as const;
export type DecisionBlock = (typeof DECISION_BLOCKS)[number];

export interface DecisionInput {
  readonly paypalEnv: string | undefined;
  readonly state: ScenarioState;
  readonly disputeId: string | null;
  /** `paypal_resource_owner(dispute)` belongs to this workspace and its mirror row is in scope */
  readonly ownsDispute: boolean;
  /** a `provide_evidence` action for this dispute `succeeded` */
  readonly evidenceFiled: boolean;
  /** the dispute mirror's current HATEOAS link rels */
  readonly allowedActions: readonly string[];
  readonly decisionRequested: boolean;
}

export interface DecisionAvailability {
  /** false outside the sandbox: the control is absent, not disabled */
  readonly shown: boolean;
  readonly enabled: boolean;
  readonly reason: DecisionBlock | null;
}

/**
 * "Simulate PayPal's decision (sandbox only)": shown only in the sandbox; enabled only when the workspace
 * owns the dispute, our evidence was filed and PayPal offers `adjudicate`. The API refuses on the same rule.
 */
export function decisionAvailability(i: DecisionInput): DecisionAvailability {
  const block = (reason: DecisionBlock): DecisionAvailability => ({
    shown: reason !== "not_sandbox",
    enabled: false,
    reason,
  });
  if (i.paypalEnv !== "sandbox") return block("not_sandbox");
  if (i.disputeId === null) return block("no_dispute");
  if (!i.ownsDispute) return block("not_owned");
  if (!isScenarioActive(i.state)) return block("finished");
  if (i.decisionRequested) return block("already_requested");
  if (!i.evidenceFiled) return block("evidence_not_filed");
  if (!i.allowedActions.includes("adjudicate")) return block("no_adjudicate_link");
  return { shown: true, enabled: true, reason: null };
}

// ---- outcome wording ------------------------------------------------------------------------------

export type ScenarioOutcomeKey = "payout_paypal_covered" | "other";

export interface MirroredOutcome {
  readonly outcome_code: string;
  readonly outcome_reason: string | null;
}

/**
 * The copy key for a RESOLVED dispute. `payout_paypal_covered` ("seller keeps the money (PayPal covered
 * the case)") only for RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL; anything else is shown with PayPal's
 * own code. Never a "win".
 */
export function scenarioOutcomeKey(
  status: string | null,
  outcome: MirroredOutcome | null,
): ScenarioOutcomeKey | null {
  if (status !== "RESOLVED" || outcome === null) return null;
  return outcome.outcome_code === "RESOLVED_WITH_PAYOUT" && outcome.outcome_reason === "REPRESENTED_BY_PAYPAL"
    ? "payout_paypal_covered"
    : "other";
}

// ---- timeline -------------------------------------------------------------------------------------

export const TIMELINE_KEYS = [
  "capture",
  "seed_pack",
  "chargeback",
  "evidence_step",
  "evidence_filed",
  "decision",
  "outcome",
] as const;
export type TimelineKey = (typeof TIMELINE_KEYS)[number];
export type TimelineStatus = "done" | "active" | "pending" | "failed";

export interface TimelineStep {
  readonly key: TimelineKey;
  readonly status: TimelineStatus;
  /** ISO time the step was observed done; null while pending */
  readonly at: string | null;
  /** the real PayPal id(s) the step produced or acts on */
  readonly paypalIds: readonly string[];
  /** what PayPal last reported for the step (e.g. `WAITING_FOR_SELLER_RESPONSE`, `PENDING / BUYER_COMPLAINT`) */
  readonly observed: string | null;
}

export interface TimelineInput {
  readonly state: ScenarioState;
  readonly steps: ScenarioSteps;
  /** when M2-08 recorded our `provide_evidence` as succeeded */
  readonly evidenceFiledAt: string | null;
  readonly decisionRequestedAt: string | null;
  readonly finishedAt: string | null;
}

/** Marks the first not-done step active (or failed when the run ended without finishing it). */
function withProgress(
  steps: Omit<TimelineStep, "status">[],
  doneKeys: ReadonlySet<TimelineKey>,
  state: ScenarioState,
) {
  let frontier = false;
  return steps.map((s): TimelineStep => {
    if (doneKeys.has(s.key)) return { ...s, status: "done" };
    if (frontier) return { ...s, status: "pending" };
    frontier = true;
    return { ...s, status: isScenarioActive(state) ? "active" : "failed" };
  });
}

/**
 * The timeline from what was recorded when each step happened (`steps`, `seen`), so times run in order
 * and each step shows the status PayPal reported at that point. `decision.observed` is `adjudicate` once
 * PayPal has offered the step; `outcome.observed` is the hold once PayPal placed one.
 */
export function scenarioTimeline(i: TimelineInput): TimelineStep[] {
  const { capture, seed_pack, chargeback } = i.steps;
  const seen = i.steps.seen ?? {};
  const done = new Set<TimelineKey>();
  if (capture) done.add("capture");
  if (seed_pack) done.add("seed_pack");
  if (chargeback) done.add("chargeback");
  if (seen.evidence_step || i.evidenceFiledAt !== null) done.add("evidence_step");
  if (i.evidenceFiledAt !== null) done.add("evidence_filed");
  if (i.decisionRequestedAt !== null || seen.resolved) done.add("decision");
  if (i.state === "resolved") done.add("outcome");
  const disputeIds = chargeback ? [chargeback.disputeId] : [];
  const outcome = seen.released ?? seen.hold;
  const steps: Omit<TimelineStep, "status">[] = [
    {
      key: "capture",
      at: capture?.at ?? null,
      paypalIds: capture ? [capture.orderId, capture.captureId] : [],
      observed: capture?.status ?? null,
    },
    { key: "seed_pack", at: seed_pack?.at ?? null, paypalIds: [], observed: null },
    { key: "chargeback", at: chargeback?.at ?? null, paypalIds: disputeIds, observed: null },
    {
      key: "evidence_step",
      at: seen.evidence_step?.at ?? null,
      paypalIds: disputeIds,
      observed: seen.evidence_step?.status ?? null,
    },
    { key: "evidence_filed", at: i.evidenceFiledAt, paypalIds: disputeIds, observed: null },
    {
      key: "decision",
      at: i.decisionRequestedAt,
      paypalIds: disputeIds,
      observed: seen.decision_offered ? "adjudicate" : null,
    },
    {
      key: "outcome",
      at: i.state === "resolved" ? (seen.resolved?.at ?? seen.released?.at ?? i.finishedAt) : null,
      paypalIds: capture ? [capture.captureId] : [],
      observed: outcome?.status ?? null,
    },
  ];
  return withProgress(steps, done, i.state);
}
