import { describe, expect, it } from "vitest";
import {
  checkCounts,
  checkCoverage,
  checkHolds,
  checkQueueLabels,
  checkReviews,
  checkSpans,
  checkSpend,
  checkSplit,
  type GoldSets,
  type Report,
} from "./checks.ts";
import { splitFor } from "./plan.ts";
import { DisagreementSchema, PROD_MODEL, REVIEW_MODEL, type Disagreement, type GoldItem, type Label } from "./schema.ts";

const CLAUDE = "claude:claude-opus-5-5";
const TEXT = "Logo in two colours. Logo files as SVG.";

function item(id: string, labels: readonly Label[], over: Partial<GoldItem> = {}): GoldItem {
  const set = over.set ?? "scope";
  const hypotheses = labels.map((label, k) => ({
    h_id: `H${String(k + 1)}`,
    text: `line ${String(k)}`,
    intended_label: label,
    field: null,
    value: null,
    fact_code: over.hold ? `fact_${String(k)}` : null,
    label,
    spans: label === "met" || label === "partial" ? [{ doc_id: "D1", start: 8, end: 19, quote: "two colours" }] : [],
    note: "",
  }));
  const review = {
    item_id: id,
    model: REVIEW_MODEL[set],
    prompt_version: "gold-review@v1",
    labels: hypotheses.map((h) => ({ h_id: h.h_id, label: h.label, spans: h.spans, unmatched_quotes: 0 })),
  };
  return {
    id,
    set,
    split: splitFor(over.hold?.pair_id ?? id),
    locale: "en",
    persona: { country: "KE", trade: "logo design", offering: "services", currency: "USD" },
    tags: [],
    injection: false,
    documents: [{ doc_id: "D1", kind: "scope", title: "Brief", text: TEXT }],
    hypotheses,
    hold: null,
    drafted_by: { model: "gpt-6.1-terra", prompt_version: "gold-draft@v1" },
    labelled_by: "owner",
    review,
    ...over,
  };
}

const report = (): Report => ({ lines: [], errors: [] });
const empty: GoldSets = { extraction: [], scope: [], holds: [] };

describe("eval:validate checks", () => {
  it("prints the counts line the gate greps, and flags a wrong count", () => {
    const r = report();
    checkCounts({ ...empty, scope: [item("scope-001", ["met"])] }, { extraction: [], scope: ["scope-001"], holds: [] }, r);
    expect(r.lines[0]).toBe("counts: extraction: 0 scope: 1 holds: 0");
    expect(r.errors).toContain("scope: 1 labelled items, expected 40");
  });

  it("counts span mismatches (AC 2) and enforces spans per label", () => {
    const bad = item("scope-001", ["met", "unverifiable"]);
    const h1 = bad.hypotheses[0];
    const h2 = bad.hypotheses[1];
    if (h1 === undefined || h2 === undefined) throw new Error("fixture");
    const broken: GoldItem = {
      ...bad,
      hypotheses: [
        { ...h1, spans: [{ doc_id: "D1", start: 9, end: 20, quote: "two colours" }] },
        { ...h2, spans: h1.spans },
      ],
    };
    const r = report();
    checkSpans({ ...empty, scope: [item("scope-002", ["met", "partial"]), broken] }, r);
    expect(r.lines).toContain("spans: 4 checked, 1 mismatches");
    expect(r.errors.join("\n")).toMatch(/H1: quote is not verbatim/);
    expect(r.errors.join("\n")).toMatch(/H2: unverifiable has spans/);
  });

  it("needs ≥ 8 scope items per label and ≥ 5 injection items", () => {
    const r = report();
    checkCoverage({ ...empty, scope: [item("scope-001", ["met", "partial", "missing", "unverifiable"], { injection: true })] }, r);
    expect(r.errors).toHaveLength(5);
  });

  it("flags a split that is not the seeded hash", () => {
    const r = report();
    const it1 = item("scope-001", ["met"]);
    checkSplit({ ...empty, scope: [{ ...it1, split: it1.split === "dev" ? "test" : "dev" }] }, r);
    expect(r.errors[0]).toMatch(/split not from the seeded hash/);
  });

  it("requires a review by a non-production model and a decision per disagreement (AC 3, AC 4)", () => {
    const agreed = item("scope-001", ["met", "missing"]);
    const reviewOf = (g: GoldItem): NonNullable<GoldItem["review"]> => {
      if (g.review === null) throw new Error("fixture");
      return g.review;
    };
    const prod = { ...item("scope-002", ["met"]), review: { ...reviewOf(agreed), item_id: "scope-002", model: PROD_MODEL.scope } };
    const base = item("scope-003", ["missing"]);
    const disputed: GoldItem = { ...base, review: { ...reviewOf(base), labels: [{ h_id: "H1", label: "met", spans: [], unmatched_quotes: 0 }] } };
    const r = report();
    checkReviews({ ...empty, scope: [agreed, prod, disputed, { ...item("scope-004", ["met"]), review: null }] }, [], r);
    expect(r.errors.join("\n")).toMatch(/scope-002: reviewed by the production model/);
    expect(r.errors.join("\n")).toMatch(/scope-003\/H1: disagreement without a decision/);
    expect(r.errors.join("\n")).toMatch(/scope-004: no review record/);
    const row: Disagreement = { set: "scope", item_id: "scope-003", h_id: "H1", labeller_label: "missing", model_label: "met", model: "x", final: "missing", reason: "the chat shows it was not sent", decided_by: "owner" };
    const ok = report();
    checkReviews({ ...empty, scope: [agreed, disputed] }, [row], ok);
    expect(ok.errors).toEqual([]);
    expect(ok.lines.find((l) => l.startsWith("kappa scope"))).toMatch(/^kappa scope \(test only\): .* n=3 hypotheses, 1 disagreements\)$/);
  });

  describe("amended AC 3 / AC 4 (owner decision 2026-11-03)", () => {
    const testItem = (id: string, labels: readonly Label[], over: Partial<GoldItem> = {}): GoldItem => item(id, labels, { split: "test", ...over });
    const devItem = (id: string, labels: readonly Label[], over: Partial<GoldItem> = {}): GoldItem =>
      item(id, labels, { split: "dev", labelled_by: `model:${REVIEW_MODEL.scope}`, ...over });
    const errorsFor = (items: GoldItem[], rows: Disagreement[] = []): string => {
      const r = report();
      checkReviews({ ...empty, scope: items }, rows, r);
      return r.errors.join("\n");
    };

    it("passes owner on test and model:<reviewer> on dev", () => {
      expect(errorsFor([testItem("scope-001", ["met"]), devItem("scope-009", ["met", "missing"])])).toBe("");
    });

    it("fails a test item labelled by a model", () => {
      expect(errorsFor([testItem("scope-001", ["met"], { labelled_by: `model:${REVIEW_MODEL.scope}` })])).toMatch(
        /scope-001: test item labelled_by model:gpt-5\.4-mini-2026-03-17, must be owner or claude:<id>/,
      );
    });

    it("accepts an owner-labelled dev item (a dev item the review could not label)", () => {
      expect(errorsFor([devItem("scope-028", ["met"], { labelled_by: "owner" })])).toBe("");
    });

    it("fails a dev item marked with a model other than its reviewer, or with the production model's review", () => {
      expect(errorsFor([devItem("scope-009", ["met"], { labelled_by: "model:someone-else" })])).toMatch(/scope-009: labelled_by model:someone-else is not its reviewer/);
      const base = devItem("scope-009", ["met"], { labelled_by: `model:${PROD_MODEL.scope}` });
      const prod: GoldItem = { ...base, review: base.review === null ? null : { ...base.review, model: PROD_MODEL.scope } };
      expect(errorsFor([prod])).toMatch(/scope-009: reviewed by the production model/);
    });

    it("fails a model-labelled dev item whose label or spans differ from its review", () => {
      const base = devItem("scope-009", ["met"]);
      const h1 = base.hypotheses[0];
      if (h1 === undefined) throw new Error("fixture");
      expect(errorsFor([{ ...base, hypotheses: [{ ...h1, label: "partial" }] }])).toMatch(/scope-009\/H1: model-labelled, but the label or spans differ/);
      expect(errorsFor([{ ...base, hypotheses: [{ ...h1, spans: [] }] }])).toMatch(/scope-009\/H1: model-labelled, but the label or spans differ/);
    });

    it("counts disagreements and kappa over test items only; a dev disagreement row is an error", () => {
      const dev = devItem("scope-009", ["missing"], { labelled_by: "owner" });
      const disputedDev: GoldItem = { ...dev, review: dev.review === null ? null : { ...dev.review, labels: [{ h_id: "H1", label: "met", spans: [], unmatched_quotes: 0 }] } };
      const r = report();
      checkReviews({ ...empty, scope: [testItem("scope-001", ["met", "missing"]), disputedDev] }, [], r);
      expect(r.errors).toEqual([]);
      expect(r.lines.find((l) => l.startsWith("kappa scope"))).toMatch(/n=2 hypotheses, 0 disagreements\)$/);
      const row: Disagreement = { set: "scope", item_id: "scope-009", h_id: "H1", labeller_label: "missing", model_label: "met", model: "x", final: "missing", reason: "dev", decided_by: "owner" };
      expect(errorsFor([disputedDev], [row])).toMatch(/scope-009\/H1: disagreements.jsonl row on a dev item/);
    });

    it("reports primary labels missing for queued items labelled by neither the owner nor Claude", () => {
      const r = report();
      const queue = { extraction: [], scope: ["scope-001", "scope-028"], holds: [] };
      checkQueueLabels({ ...empty, scope: [testItem("scope-001", ["met"]), devItem("scope-028", ["met"])] }, queue, r);
      expect(r.lines).toContain("labelled: 1/2 queued items (test split + dev items the review could not label): owner 1");
      expect(r.errors).toEqual(["labels missing: 1/2 queued items: run `pnpm eval:label`, then `pnpm eval:label --reconcile`"]);
      const ok = report();
      checkQueueLabels({ ...empty, scope: [testItem("scope-001", ["met"]), devItem("scope-028", ["met"], { labelled_by: CLAUDE })] }, queue, ok);
      expect(ok.errors).toEqual([]);
      expect(ok.lines).toContain(`labelled: 2/2 queued items (test split + dev items the review could not label): ${CLAUDE} 1, owner 1`);
    });
  });

  describe("amended AC 3 (owner decision 2026-11-04: Claude labels the gold sets)", () => {
    const errorsFor = (items: GoldItem[], rows: Disagreement[] = []): string => {
      const r = report();
      checkReviews({ ...empty, scope: items }, rows, r);
      return r.errors.join("\n");
    };

    it("passes claude:<id> on a test item and on a dev item the review could not label", () => {
      expect(errorsFor([item("scope-001", ["met"], { split: "test", labelled_by: CLAUDE }), item("scope-028", ["met"], { split: "dev", labelled_by: CLAUDE })])).toBe("");
    });

    it("must fail: a test item marked model:<id>, even the item's own reviewer", () => {
      expect(errorsFor([item("scope-001", ["met"], { split: "test", labelled_by: `model:${REVIEW_MODEL.scope}` })])).toMatch(/scope-001: test item labelled_by model:.*must be owner or claude:<id>/);
    });

    it("fails a labeller id equal to the task's production model", () => {
      expect(errorsFor([item("scope-001", ["met"], { split: "test", labelled_by: `claude:${PROD_MODEL.scope}` })])).toMatch(
        new RegExp(`scope-001: labelled_by claude:${PROD_MODEL.scope.replace(/\./g, "\\.")} is the production model for scope`),
      );
      const ext = item("ext-001", ["met"], { set: "extraction", split: "test", labelled_by: `claude:${PROD_MODEL.extraction}` });
      expect(errorsFor([ext])).toMatch(/ext-001: labelled_by claude:.* is the production model for extraction/);
    });

    it("records who decided a disagreement, and refuses a row without decided_by", () => {
      const base = item("scope-003", ["missing"], { split: "test", labelled_by: CLAUDE });
      const disputed: GoldItem = { ...base, review: base.review === null ? null : { ...base.review, labels: [{ h_id: "H1", label: "met", spans: [], unmatched_quotes: 0 }] } };
      const row: Disagreement = { set: "scope", item_id: "scope-003", h_id: "H1", labeller_label: "missing", model_label: "met", model: "x", final: "missing", reason: "the handover says it was not sent", decided_by: CLAUDE };
      expect(errorsFor([disputed], [row])).toBe("");
      expect(DisagreementSchema.safeParse({ ...row, decided_by: undefined }).success).toBe(false);
      expect(DisagreementSchema.safeParse({ ...row, decided_by: `model:${REVIEW_MODEL.scope}` }).success).toBe(false);
    });
  });

  it("checks EN/HI hold pairs share fact codes and name a known rule", () => {
    const hold = { pair_id: "hold-01", capture_reason: "PENDING_REVIEW", sample: false, expected_rule_id: "payment_review", forbidden_claims: ["seller_won" as const] };
    const en = item("hold-01-en", ["met"], { set: "holds", hold });
    const hi = item("hold-01-hi", ["met"], { set: "holds", hold, locale: "hi" });
    const r = report();
    checkHolds([en, hi], r);
    expect(r.errors).toEqual(["holds: need 10 EN and 10 HI"]);
    const r2 = report();
    checkHolds([en, { ...hi, hold: { ...hold, expected_rule_id: "nope" } }], r2);
    expect(r2.errors.join("\n")).toMatch(/unknown rule nope/);
  });

  it("keeps every UTC day within the daily budget", () => {
    const r = report();
    checkSpend(new Map([["2026-11-03", 0.48], ["2026-11-04", 1.2]]), r);
    expect(r.errors).toEqual(["spend 2026-11-04: $1.2000 over the $1.00 daily budget"]);
    expect(r.lines).toContain("spend total: $1.6800");
  });
});
