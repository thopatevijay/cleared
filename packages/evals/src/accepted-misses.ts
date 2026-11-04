// Accepted misses: a set that misses its absolute bar (THRESHOLDS) but is allowed to gate CI at a recorded
// baseline instead. The bar itself is never changed: the report, the README and the runner output still say
// MISS. The gate fails on any regression below the baseline. Owner decision 2026-11-04 (#46).
import type { EvalReport } from "./report.ts";

type HoldsReport = NonNullable<EvalReport["sets"]["holds"]>;

export interface HoldsBaseline {
  readonly set: "holds";
  readonly decision: string;
  readonly min: {
    readonly explanations: number;
    readonly facts: number;
    readonly rule: number;
    readonly language: number;
    readonly parity: number;
  };
  readonly maxForbidden: number;
}

export const ACCEPTED_HOLDS: HoldsBaseline = {
  set: "holds",
  decision: "#46 owner 2026-11-04",
  min: { explanations: 10 / 16, facts: 58 / 64, rule: 1, language: 1, parity: 1 },
  maxForbidden: 0,
};

const EPS = 1e-9;

/** True when the holds numbers are at or above the accepted baseline. */
export function holdsAtBaseline(h: HoldsReport, b: HoldsBaseline = ACCEPTED_HOLDS): boolean {
  return (
    h.accuracy.rate >= b.min.explanations - EPS &&
    h.fact_accuracy.rate >= b.min.facts - EPS &&
    h.rule_ok.rate >= b.min.rule - EPS &&
    h.language_ok.rate >= b.min.language - EPS &&
    h.pair_parity.rate >= b.min.parity - EPS &&
    h.forbidden_claims <= b.maxForbidden
  );
}

/** Holds misses its bar but is gated at the accepted baseline. */
export function holdsAccepted(r: EvalReport): boolean {
  return r.sets.holds !== null && !r.sets.holds.pass && holdsAtBaseline(r.sets.holds);
}

/** The CI gate: every set at its absolute threshold, except holds, which may sit at its accepted baseline. */
export function gatePasses(r: EvalReport): boolean {
  const { extraction, scope, holds } = r.sets;
  const holdsOk = holds === null || holds.pass || holdsAtBaseline(holds);
  return [extraction, scope, r.adversarial].every((x) => x === null || x.pass) && holdsOk && r.trajectory.pass;
}
