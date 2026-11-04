// The CI gate with the accepted holds miss (#46, owner 2026-11-04): pure functions over a report, no I/O.
import { describe, expect, it } from "vitest";
import { ACCEPTED_HOLDS, gatePasses, holdsAccepted } from "../src/accepted-misses.ts";
import type { EvalReport, RateJson } from "../src/report.ts";

const r = (k: number, n: number): RateJson => ({ k, n, rate: n === 0 ? 0 : k / n, ci95: [0, 1] });
type Holds = NonNullable<EvalReport["sets"]["holds"]>;
type Extraction = NonNullable<EvalReport["sets"]["extraction"]>;

const common = { items: 1, hypotheses: 1, per_label: {}, macro_f1: 1, cost_per_pack_usd: 0, latency: {}, failed_runs: 0 };

function holds(o: Partial<Holds> = {}): Holds {
  return {
    ...common,
    accuracy: r(10, 16),
    threshold: 0.95,
    pass: false,
    fact_accuracy: r(58, 64),
    rule_ok: r(16, 16),
    language_ok: r(16, 16),
    forbidden_claims: 0,
    fallbacks: 0,
    pair_parity: r(8, 8),
    judge_cost_usd: 0,
    ...o,
  };
}

function extraction(k: number): Extraction {
  return { ...common, accuracy: r(k, 100), threshold: 0.9, pass: k / 100 >= 0.9 };
}

function report(h: Holds | null, e: Extraction | null = extraction(96)): EvalReport {
  return {
    schema: "eval-report@v1",
    generated_at: "2026-11-04T00:00:00Z",
    commit: "test",
    mode: "replay",
    split: "test",
    claims: { wording: "", kappa: {} },
    models: { small: "s", large: "l", judge: "l" },
    prompt_versions: [],
    live_run: null,
    sets: { extraction: e, scope: null, holds: h },
    adversarial: null,
    trajectory: { runs: 1, max_calls_per_run: 1, max_output_tokens_step: 1, max_run_latency_ms: 1, pass: true },
    pass: false,
  };
}

describe("accepted holds miss", () => {
  it("the baseline in config is the owner's", () => {
    expect(ACCEPTED_HOLDS.decision).toBe("#46 owner 2026-11-04");
    expect(ACCEPTED_HOLDS.maxForbidden).toBe(0);
  });

  it("holds at the baseline passes the gate but still reads MISS", () => {
    const rep = report(holds());
    expect(rep.sets.holds?.pass).toBe(false);
    expect(holdsAccepted(rep)).toBe(true);
    expect(gatePasses(rep)).toBe(true);
  });

  it.each([
    ["explanations", holds({ accuracy: r(9, 16) })],
    ["facts", holds({ fact_accuracy: r(57, 64) })],
    ["rule", holds({ rule_ok: r(15, 16) })],
    ["language", holds({ language_ok: r(15, 16) })],
    ["parity", holds({ pair_parity: r(7, 8) })],
    ["forbidden claims", holds({ forbidden_claims: 1 })],
  ])("holds below the baseline (%s) fails the gate", (_name, h) => {
    const rep = report(h);
    expect(holdsAccepted(rep)).toBe(false);
    expect(gatePasses(rep)).toBe(false);
  });

  it("holds above the baseline still passes", () => {
    expect(gatePasses(report(holds({ accuracy: r(12, 16) })))).toBe(true);
  });

  it("extraction below its threshold still fails, whatever holds does", () => {
    expect(gatePasses(report(holds(), extraction(85)))).toBe(false);
  });
});
