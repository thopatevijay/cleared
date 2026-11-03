import { describe, expect, it } from "vitest";
import { labelItem, parseLabel, reconcileItem, type Prompter } from "./label-core.ts";
import type { DraftItem, GoldItem, Review } from "./schema.ts";

function scripted(answers: readonly string[]): Prompter & { said: string[] } {
  const queue = [...answers];
  const said: string[] = [];
  return {
    said,
    ask: (q) => {
      const next = queue.shift();
      return next === undefined ? Promise.reject(new Error(`script ran out at: ${q}`)) : Promise.resolve(next);
    },
    say: (t) => {
      said.push(t);
    },
  };
}

const draft: DraftItem = {
  id: "scope-001",
  set: "scope",
  split: "test",
  locale: "en",
  persona: { country: "NG", trade: "logo design", offering: "services", currency: "USD" },
  tags: [],
  injection: false,
  documents: [
    { doc_id: "D1", kind: "scope", title: "Brief", text: "Logo in two colours. Logo files as SVG." },
    { doc_id: "D2", kind: "delivery", title: "Handover", text: "Sent the SVG files today." },
  ],
  hypotheses: [
    { h_id: "H1", text: "Logo files as SVG", intended_label: "met", field: null, value: null, fact_code: null },
    { h_id: "H2", text: "Brand guide", intended_label: "unverifiable", field: null, value: null, fact_code: null },
  ],
  hold: null,
  drafted_by: { model: "gpt-6.1-terra", prompt_version: "gold-draft@v1" },
};

describe("eval:label (owner step)", () => {
  it("parses label keys", () => {
    expect(["m", "P", " x ", "u", "s", "q", "z"].map(parseLabel)).toEqual(["met", "partial", "missing", "unverifiable", "skip", "quit", null]);
  });

  it("records labels, spans by quote (resolving an ambiguous quote) and notes", async () => {
    const io = scripted(["met", "m", "nope", "SVG", "2", "", "clear", "u", ""]);
    const out = await labelItem(draft, io);
    if (out === "skip" || out === "quit") throw new Error("expected an item");
    expect(out.labelled_by).toBe("owner");
    expect(out.hypotheses[0]).toMatchObject({ label: "met", note: "clear", spans: [{ doc_id: "D2", start: 9, end: 12, quote: "SVG" }] });
    expect(out.hypotheses[1]).toMatchObject({ label: "unverifiable", spans: [] });
    expect(io.said.join("\n")).toContain("not found verbatim");
    expect(io.said.join("\n")).not.toContain("intended");
  });

  it("will not save met without a quote, and quits cleanly", async () => {
    const io = scripted(["m", "", "two colours", "", "", "q"]);
    expect(await labelItem(draft, io)).toBe("quit");
    expect(io.said.join("\n")).toContain("met needs at least one quote");
  });

  it("reconciles: embeds the review, asks once per disagreement, adopts the model's spans when chosen", async () => {
    const gold: GoldItem = {
      ...draft,
      hypotheses: draft.hypotheses.map((h) => ({ ...h, label: "unverifiable", spans: [], note: "" })),
      labelled_by: "owner",
      review: null,
    };
    const span = { doc_id: "D2", start: 9, end: 12, quote: "SVG" };
    const review: Review = {
      item_id: "scope-001",
      model: "gpt-5.4-mini-2026-03-17",
      prompt_version: "gold-review@v1",
      labels: [
        { h_id: "H1", label: "met", spans: [span], unmatched_quotes: 0 },
        { h_id: "H2", label: "unverifiable", spans: [], unmatched_quotes: 0 },
      ],
    };
    const { item, rows } = await reconcileItem(gold, review, [], scripted(["r", "handover lists the SVG files"]));
    expect(item.review).toEqual(review);
    expect(item.hypotheses[0]).toMatchObject({ label: "met", spans: [span] });
    expect(rows).toEqual([
      { set: "scope", item_id: "scope-001", h_id: "H1", owner_label: "unverifiable", model_label: "met", model: review.model, final: "met", reason: "handover lists the SVG files" },
    ]);
    const again = await reconcileItem(item, review, rows, scripted([]));
    expect(again.rows).toEqual(rows);
    expect(again.item).toEqual(item);
  });
});
