import { describe, expect, it } from "vitest";
import { adoptDevItem, adoptDevSet, adoptionProblem, ownerQueue } from "./adopt.ts";
import { checkSpans, type Report } from "./checks.ts";
import { PROD_MODEL, REVIEW_MODEL, type DraftItem, type GoldItem, type Review } from "./schema.ts";

const docs = [
  { doc_id: "D1", kind: "scope" as const, title: "Brief", text: "Logo in two colours. Logo files as SVG." },
  { doc_id: "D2", kind: "delivery" as const, title: "Handover", text: "Sent the SVG files today." },
];

function draft(id: string, split: "dev" | "test"): DraftItem {
  return {
    id,
    set: "scope",
    split,
    locale: "en",
    persona: { country: "NG", trade: "logo design", offering: "services", currency: "USD" },
    tags: [],
    injection: false,
    documents: docs,
    hypotheses: [
      { h_id: "H1", text: "Logo files as SVG", intended_label: "met", field: null, value: null, fact_code: null },
      { h_id: "H2", text: "Brand guide", intended_label: "unverifiable", field: null, value: null, fact_code: null },
    ],
    hold: null,
    drafted_by: { model: "gpt-6.1-terra", prompt_version: "gold-draft@v1" },
  };
}

const span = { doc_id: "D2", start: 9, end: 12, quote: "SVG" };

function review(id: string, h1: Review["labels"][number] = { h_id: "H1", label: "met", spans: [span], unmatched_quotes: 0 }): Review {
  return {
    item_id: id,
    model: REVIEW_MODEL.scope,
    prompt_version: "gold-review@v1",
    labels: [h1, { h_id: "H2", label: "unverifiable", spans: [], unmatched_quotes: 0 }],
  };
}

/** The scope-028/H2 case: the reviewer said met, but its only quote was not verbatim, so it has no span. */
const noSpan = (id: string): Review => review(id, { h_id: "H1", label: "met", spans: [], unmatched_quotes: 1 });

describe("eval:adopt-dev (dev items from the review)", () => {
  it("adopts the review's labels and spans verbatim, marked model:<reviewer>, and the spans pass the verbatim check", () => {
    const out = adoptDevItem(draft("scope-009", "dev"), review("scope-009"));
    expect(out.labelled_by).toBe(`model:${REVIEW_MODEL.scope}`);
    expect(out.review).toEqual(review("scope-009"));
    expect(out.hypotheses.map((h) => [h.label, h.spans])).toEqual([["met", [span]], ["unverifiable", []]]);
    const r: Report = { lines: [], errors: [] };
    checkSpans({ extraction: [], scope: [out], holds: [] }, r);
    expect(r.errors).toEqual([]);
  });

  it("refuses a dev item whose met has no verbatim span, and queues it for the owner", () => {
    const d = draft("scope-028", "dev");
    expect(adoptionProblem(d, noSpan("scope-028"))).toBe("scope-028/H1: the reviewer's met has no verbatim span (1 quote(s) not verbatim)");
    expect(() => adoptDevItem(d, noSpan("scope-028"))).toThrow(/no verbatim span/);
    const { items, refused } = adoptDevSet([d], [noSpan("scope-028")], []);
    expect(items).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(ownerQueue([draft("scope-001", "test"), d, draft("scope-009", "dev")], [noSpan("scope-028"), review("scope-009")]).map((x) => x.id)).toEqual(["scope-001", "scope-028"]);
  });

  it("refuses a non-verbatim span, a production-model review and a test item", () => {
    const bad = review("scope-009", { h_id: "H1", label: "met", spans: [{ ...span, start: 10, end: 13 }], unmatched_quotes: 0 });
    expect(adoptionProblem(draft("scope-009", "dev"), bad)).toMatch(/quote is not verbatim/);
    expect(adoptionProblem(draft("scope-009", "dev"), { ...review("scope-009"), model: PROD_MODEL.scope })).toMatch(/production model/);
    expect(adoptionProblem(draft("scope-001", "test"), review("scope-001"))).toMatch(/only dev items/);
  });

  it("keeps the owner's items, in draft order, and is idempotent", () => {
    const owner: GoldItem = { ...adoptDevItem(draft("scope-009", "dev"), review("scope-009")), id: "scope-001", split: "test", labelled_by: "owner", review: null };
    const ownedDev: GoldItem = { ...adoptDevItem(draft("scope-028", "dev"), review("scope-028")), labelled_by: "owner" };
    const drafts = [draft("scope-001", "test"), draft("scope-002", "test"), draft("scope-009", "dev"), draft("scope-028", "dev")];
    const reviews = [review("scope-009"), noSpan("scope-028")];
    const once = adoptDevSet(drafts, reviews, [ownedDev, owner]);
    expect(once.items.map((i) => [i.id, i.labelled_by])).toEqual([["scope-001", "owner"], ["scope-009", `model:${REVIEW_MODEL.scope}`], ["scope-028", "owner"]]);
    expect(once.refused).toEqual([]);
    expect(adoptDevSet(drafts, reviews, once.items).items).toEqual(once.items);
  });
});
