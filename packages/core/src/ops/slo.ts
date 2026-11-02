// M3-09 (architecture §9, ADR 0013): the reconcile job's SLO checks and the synthetic judge path's step
// budget, as pure functions over measured samples. The worker gathers the samples, stores each result in
// `ops_checks` and raises a Sentry warning on a breach. A latency check with no samples passes with a null
// value: nothing happened to measure, which is not a breach.

export interface OpsCheckResult {
  readonly check: string;
  /** In the check's unit (seconds or a count); null when there was nothing to measure. */
  readonly value: number | null;
  readonly target: number;
  readonly pass: boolean;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export const HOUR_MS = 60 * 60_000;

/** The SLO targets (architecture §9). Latencies in seconds. */
export const SLO_TARGETS = {
  /** webhook received → hold visible, p99 */
  holdVisibleSeconds: 120,
  /** seller approved → PayPal 2xx, p99 */
  approvedToPaypalSeconds: 300,
  /** open disputes past `seller_response_due_date` with no filed action */
  missedDeadlines: 0,
  /** the last passing synthetic judge-path run */
  syntheticMaxAgeSeconds: 26 * 3600,
} as const;

/** Latency samples are taken over the last day. */
export const SLO_WINDOW_MS = 24 * HOUR_MS;

/** The reconcile tick runs every 15 minutes; `/readyz` fails once the last tick is 30 minutes old. */
export const RECONCILE_CRON = "*/15 * * * *";
export const RECONCILE_MAX_AGE_MS = 30 * 60_000;
/** Captures that changed within this window are re-read even when no longer PENDING. */
export const RECONCILE_RECENT_MS = 72 * HOUR_MS;
/**
 * An `unknown` action with no audit activity for this long has lost its reconcile chain (tries 2, 4, 8 and
 * 16 minutes apart: 30 minutes after the first), so the poll gives it one final try.
 */
export const STRANDED_UNKNOWN_AFTER_MS = 45 * 60_000;

export const CHECK_NAMES = {
  reconcile: "reconcile",
  holdVisible: "slo.hold_visible_p99",
  approvedToPaypal: "slo.approved_to_paypal_p99",
  missedDeadlines: "slo.missed_deadlines",
  syntheticFresh: "slo.synthetic_fresh",
  synthetic: "synthetic",
} as const;

/** Nearest-rank percentile (p in (0, 100]); null for no samples. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function latencyCheck(check: string, samplesSeconds: readonly number[], target: number): OpsCheckResult {
  const p99 = percentile(samplesSeconds, 99);
  return {
    check,
    value: p99 === null ? null : round(p99),
    target,
    pass: p99 === null || p99 < target,
    detail: { samples: samplesSeconds.length },
  };
}

/** Webhook received → hold visible (the `holds` row exists), p99 < 2 min. */
export function holdVisibleCheck(samplesSeconds: readonly number[]): OpsCheckResult {
  return latencyCheck(CHECK_NAMES.holdVisible, samplesSeconds, SLO_TARGETS.holdVisibleSeconds);
}

/** Approved → PayPal 2xx, p99 < 5 min. */
export function approvedToPaypalCheck(samplesSeconds: readonly number[]): OpsCheckResult {
  return latencyCheck(CHECK_NAMES.approvedToPaypal, samplesSeconds, SLO_TARGETS.approvedToPaypalSeconds);
}

export interface DeadlineSample {
  readonly disputeId: string;
  readonly open: boolean;
  /** epoch ms of `seller_response_due_date`; null = no deadline */
  readonly dueAtMs: number | null;
  /** a dispute action of this workspace succeeded at PayPal */
  readonly filed: boolean;
}

/** Open disputes past their due date with no filed action: must be 0. */
export function missedDeadlinesCheck(disputes: readonly DeadlineSample[], nowMs: number): OpsCheckResult {
  const missed = disputes.filter((d) => d.open && !d.filed && d.dueAtMs !== null && d.dueAtMs < nowMs);
  return {
    check: CHECK_NAMES.missedDeadlines,
    value: missed.length,
    target: SLO_TARGETS.missedDeadlines,
    pass: missed.length <= SLO_TARGETS.missedDeadlines,
    detail: { watched: disputes.length, first: missed[0]?.disputeId ?? null },
  };
}

/** The last passing synthetic run is < 26 h old; never having passed is a breach. */
export function syntheticFreshCheck(lastPassMs: number | null, nowMs: number): OpsCheckResult {
  const age = lastPassMs === null ? null : Math.max(0, Math.round((nowMs - lastPassMs) / 1000));
  return {
    check: CHECK_NAMES.syntheticFresh,
    value: age,
    target: SLO_TARGETS.syntheticMaxAgeSeconds,
    pass: age !== null && age < SLO_TARGETS.syntheticMaxAgeSeconds,
    detail: { lastPassAt: lastPassMs === null ? null : new Date(lastPassMs).toISOString() },
  };
}

/** `/readyz`: the last reconcile tick finished less than 30 minutes ago. */
export function reconcileFresh(lastRunMs: number | null, nowMs: number): boolean {
  return lastRunMs !== null && nowMs - lastRunMs < RECONCILE_MAX_AGE_MS;
}

// ---- the synthetic judge path ------------------------------------------------------------------

/**
 * The steps in order, each with its target in seconds (time since the previous step finished). A target is
 * **soft**: a slower step is recorded (`synthetic.<step>` pass = false, `slowSteps` on the run row) but
 * the run waits on, since most of the time is PayPal's own sandbox clock. The only hard limit is the
 * ticket's end to end `SYNTHETIC_MAX_SECONDS`. Every step is observed by polling (the M2-10 `scenario.poll`
 * job re-fetches the dispute and the capture every 30 s, so a sighting lags PayPal by up to 30 s); no step
 * waits on a webhook, which a local run never receives (BL-01 6568286398).
 *
 * Measured PayPal sandbox times (chargeback → …), the basis of each target:
 * - hold `PENDING / BUYER_COMPLAINT`: 3 min 05 s (docs/evidence/m0-05-paypal-spike-b.md), 3 min 15 s
 *   (docs/evidence/M2-GATE.md), 3 min 45 s and > 5 min (M3-09 live runs, 2026-11-02). It moves with the
 *   time-based `WAITING_FOR_SELLER_RESPONSE` (+3 min 33–35 s, M0-05). Target 300 s, the ticket's "≤ 5 min".
 * - `provide_evidence` offered and drafted: 44 s after the hold (M2-GATE), 5 s (M3-09) → 300 s
 * - evidence filed after approval: 6 s (M2-GATE), 10 s (M3-09) → 300 s (the approved → 2xx SLO)
 * - `adjudicate` offered after the evidence: 3 min 24 s (M0-05), 3 min 34 s (M2-GATE), 3 min 40 s (M3-09) → 600 s
 * - RESOLVED and capture COMPLETED after adjudicate: 6 min 35 s (M0-05), 4 min 25 s (M2-GATE),
 *   6 min 25 s (M3-09) → 900 s
 * Whole path: 12.5 min (M2-GATE), ≈ 15 min with prompt actions (M0-05), 14.3 min (M3-09).
 */
export const SYNTHETIC_STEPS = [
  { step: "capture", targetSeconds: 120 },
  { step: "chargeback", targetSeconds: 180 },
  { step: "buyer_complaint_hold", targetSeconds: 300 },
  { step: "evidence_proposed", targetSeconds: 300 },
  { step: "evidence_filed", targetSeconds: 300 },
  { step: "sandbox_decision", targetSeconds: 600 },
  { step: "released", targetSeconds: 900 },
] as const;

export type SyntheticStep = (typeof SYNTHETIC_STEPS)[number]["step"];

/** The whole path, from workspace creation to the release. */
export const SYNTHETIC_MAX_SECONDS = 30 * 60;
/** Once per UTC day (03:00, outside the judging hours of either coast). */
export const SYNTHETIC_CRON = "0 3 * * *";

export function syntheticStepCheck(step: SyntheticStep, seconds: number): OpsCheckResult {
  const target = SYNTHETIC_STEPS.find((s) => s.step === step)?.targetSeconds ?? SYNTHETIC_MAX_SECONDS;
  return { check: `synthetic.${step}`, value: round(seconds), target, pass: seconds <= target, detail: {} };
}

/**
 * The run's own row: passed = released end to end within 30 minutes. `failedStep` is the step that
 * errored or was still waiting at the limit; `slowSteps` the ones over their (soft) target.
 */
export function syntheticRunCheck(
  totalSeconds: number,
  failedStep: string | null,
  slowSteps: readonly string[] = [],
): OpsCheckResult {
  return {
    check: CHECK_NAMES.synthetic,
    value: round(totalSeconds),
    target: SYNTHETIC_MAX_SECONDS,
    pass: failedStep === null && totalSeconds <= SYNTHETIC_MAX_SECONDS,
    detail: { failedStep, slowSteps: slowSteps.join(",") },
  };
}
