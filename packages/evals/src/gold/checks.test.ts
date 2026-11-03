import { describe, expect, it } from "vitest";
import {
  checkCounts,
  checkCoverage,
  checkHolds,
  checkReviews,
  checkSpans,
  checkSpend,
  checkSplit,
  type GoldSets,
  type Report,
} from "./checks.ts";
import { splitFor } from "./plan.ts";
import { PROD_MODEL, REVIEW_MODEL, type Disagreement, type GoldItem, type Label } from "./schema.ts";

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
    const prod = { ...item("scope-002", ["met"]), review: { ...agreed.review!, item_id: "scope-002", model: PROD_MODEL.scope } };
    const base = item("scope-003", ["missing"]);
    const disputed: GoldItem = { ...base, review: { ...base.review!, labels: [{ h_id: "H1", label: "met", spans: [], unmatched_quotes: 0 }] } };
    const r = report();
    checkReviews({ ...empty, scope: [agreed, prod, disputed, { ...item("scope-004", ["met"]), review: null }] }, [], r);
    expect(r.errors.join("\n")).toMatch(/scope-002: reviewed by the production model/);
    expect(r.errors.join("\n")).toMatch(/scope-003\/H1: disagreement without a decision/);
    expect(r.errors.join("\n")).toMatch(/scope-004: no review record/);
    const row: Disagreement = { set: "scope", item_id: "scope-003", h_id: "H1", owner_label: "missing", model_label: "met", model: "x", final: "missing", reason: "the chat shows it was not sent" };
    const ok = report();
    checkReviews({ ...empty, scope: [agreed, disputed] }, [row], ok);
    expect(ok.errors).toEqual([]);
    expect(ok.lines.find((l) => l.startsWith("kappa scope"))).toMatch(/^kappa scope: .* n=3 hypotheses, 1 disagreements\)$/);
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
