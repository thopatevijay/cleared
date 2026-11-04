// Scoring and report units (M4-02): the statistics, the matchers, and the README block contract.
import { describe, expect, it } from "vitest";
import { loadItems } from "../src/evaluate.ts";
import {
  checkReadme,
  EvalReportSchema,
  readmeBlock,
  README_END,
  README_START,
  withReadmeBlock,
  type EvalReport,
} from "../src/report.ts";
import {
  amountOf,
  containment,
  factParity,
  isoDateOf,
  matchLines,
  percentile,
  perLabel,
  scoreExtraction,
  scoreHold,
  tokenIoU,
  wilson,
} from "../src/score.ts";
import { EMPTY_FACTS } from "./support.ts";

describe("statistics", () => {
  it("Wilson 95% interval matches the closed form", () => {
    const r = wilson(28, 31);
    expect(r.rate).toBeCloseTo(0.9032, 4);
    expect(r.ci95[0]).toBeCloseTo(0.7509, 3);
    expect(r.ci95[1]).toBeCloseTo(0.9665, 3);
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, rate: 0, ci95: [0, 0] });
  });

  it("percentiles are nearest-rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("per-label precision/recall and macro-F1 over labels present in the gold", () => {
    const { labels, macroF1 } = perLabel([
      ["met", "met"],
      ["met", "partial"],
      ["missing", "missing"],
      ["partial", "none"],
    ]);
    expect(labels.met).toMatchObject({ precision: 1, recall: 0.5, support: 2 });
    expect(labels.partial).toMatchObject({ precision: 0, recall: 0, support: 1 });
    expect(macroF1).toBeCloseTo((2 / 3 + 0 + 1) / 3, 6);
  });
});

describe("matchers", () => {
  it("normalises dates and amounts", () => {
    expect(isoDateOf("20 September 2025")).toBe("2025-09-20");
    expect(isoDateOf("September 3, 2025")).toBe("2025-09-03");
    expect(isoDateOf("delivery deadline")).toBeNull();
    expect(amountOf("USD 1,250.00")).toEqual({ currency: "USD", value: 1250 });
  });

  it("token IoU and containment", () => {
    const t = "one two three four";
    expect(tokenIoU(t, [0, 7], [4, 13])).toBeCloseTo(1 / 3, 6);
    expect(containment("six mobile app UI screens", "Design of six mobile app UI screens for a plant-care app")).toBe(1);
  });

  it("matches model lines to gold lines one to one", () => {
    const item = loadItems("scope", "test")[0];
    if (!item) throw new Error("no item");
    const lines = item.hypotheses.map((h, i) => ({
      line_id: `C${String(i + 1)}`,
      requirement: h.text,
      line_citation: null,
      model_verdict: "met" as const,
      verdict: "met" as const,
      note: null,
      citations: [],
      rationale: "",
      dropped: [],
    }));
    expect(matchLines(item.hypotheses, [...lines].reverse()).map((m) => m.line_id)).toEqual(lines.map((l) => l.line_id));
  });

  it("scores extraction field by field (a found value is right only when the gold supports it)", () => {
    const item = loadItems("extraction", "test").find((i) => i.hypotheses.some((h) => h.field === "amount" && h.value));
    if (!item) throw new Error("no item");
    const amount = item.hypotheses.find((h) => h.field === "amount" && h.value);
    const a = amountOf(amount?.value ?? "");
    const facts = {
      ...EMPTY_FACTS,
      amounts: a ? [{ value: String(a.value), currency: a.currency, refers_to: "fee", evidence_item_id: "E1", source_quote: "fee" }] : [],
    };
    const scored = scoreExtraction(item, [facts]);
    expect(scored.find((s) => s.h_id === amount?.h_id)).toMatchObject({ found: true, correct: true });
  });
});

describe("holds", () => {
  const item = loadItems("holds", "test").find((i) => i.locale === "en");
  if (!item) throw new Error("no hold item");
  const conveyed = new Map(item.hypotheses.map((h) => [h.h_id, h.label === "met"] as const));
  const base = { item, expectedRuleId: item.hold?.expected_rule_id ?? "", shownRuleId: item.hold?.expected_rule_id ?? "", modelRuleId: item.hold?.expected_rule_id ?? "", text: "PayPal is reviewing this payment.", guardrailProblems: [], conveyed, ai: true };

  it("passes only with the right rule, language, no forbidden claim and every fact as labelled", () => {
    expect(scoreHold(base).pass).toBe(true);
    expect(scoreHold({ ...base, modelRuleId: "other" }).pass).toBe(false);
    expect(scoreHold({ ...base, text: "पेमेंट" }).languageOk).toBe(false);
    expect(scoreHold({ ...base, guardrailProblems: ["promise_word: guaranteed"] }).forbidden).toEqual(["guaranteed_release"]);
    expect(scoreHold({ ...base, text: "You won the case." }).forbidden).toEqual(["seller_won"]);
    expect(scoreHold({ ...base, ai: false }).pass).toBe(false);
  });

  it("EN/HI parity compares the fact codes conveyed", () => {
    const s = scoreHold(base);
    expect(factParity(s, s)).toBe(true);
    expect(factParity(s, scoreHold({ ...base, conveyed: new Map() }))).toBe(false);
  });
});

describe("report and README block", () => {
  const rate = { k: 9, n: 10, rate: 0.9, ci95: [0.596, 0.982] as [number, number] };
  const report: EvalReport = EvalReportSchema.parse({
    schema: "eval-report@v1",
    generated_at: "2026-11-04T00:00:00.000Z",
    commit: "abc1234",
    mode: "replay",
    split: "test",
    claims: { wording: "w", kappa: { scope: 0.834 } },
    models: { small: "s", large: "l", judge: "l" },
    prompt_versions: ["check_scope@v1"],
    live_run: null,
    sets: { extraction: null, holds: null, scope: { items: 3, hypotheses: 10, accuracy: rate, per_label: {}, macro_f1: 0.8, cost_per_pack_usd: 0.01, latency: {}, failed_runs: 0, threshold: 0.9, pass: true, span_iou: rate, verbatim: { ...rate, k: 10, rate: 1 }, uncited_supported: 0, visual_citations: 0, dropped_quotes: 1, unmatched_lines: 0 } },
    adversarial: null,
    trajectory: { runs: 3, max_calls_per_run: 2, max_output_tokens_step: 100, max_run_latency_ms: 10, pass: true },
    pass: true,
  });

  it("renders a block the check accepts, and rejects a hand-edited number", () => {
    const readme = withReadmeBlock("# X\n\n## Measured results\n\n<!-- Filled by M4-02 -->\n\n## Next\n", readmeBlock(report));
    expect(readme).toContain(README_START);
    expect(readme).toContain("## Next");
    expect(checkReadme(readme, report)).toBeNull();
    expect(checkReadme(readme.replace("90.0%", "95.0%"), report)).toContain("differs");
    expect(withReadmeBlock(readme, readmeBlock(report))).toBe(readme);
    expect(readme.indexOf(README_END)).toBeGreaterThan(readme.indexOf(README_START));
  });
});
