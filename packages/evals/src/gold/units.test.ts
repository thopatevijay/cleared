import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cohensKappa } from "./kappa.ts";
import { scanText } from "./pii.ts";
import type { GoldDocument } from "./schema.ts";
import { locateQuote, spanProblem } from "./spans.ts";
import { createSpendLedger, spendByDay } from "./spend.ts";

const docs: GoldDocument[] = [
  { doc_id: "D1", kind: "scope", title: "Brief", text: "Logo in two colours. Logo files as SVG." },
  { doc_id: "D2", kind: "delivery", title: "Handover", text: "Sent the SVG files today." },
];

describe("spans", () => {
  it("computes offsets from a quote", () => {
    expect(locateQuote(docs, "two colours")).toEqual({
      kind: "ok",
      span: { doc_id: "D1", start: 8, end: 19, quote: "two colours" },
    });
    expect(locateQuote(docs, "three colours")).toEqual({ kind: "not_found" });
  });

  it("asks which place when a quote occurs more than once, and honours a pick", () => {
    const amb = locateQuote(docs, "SVG");
    expect(amb.kind).toBe("ambiguous");
    expect(locateQuote(docs, "SVG", null, 1)).toMatchObject({ kind: "ok", span: { doc_id: "D2", start: 9 } });
    expect(locateQuote(docs, "SVG", "D2")).toMatchObject({ kind: "ok", span: { doc_id: "D2" } });
  });

  it("reports a span that is not verbatim at its offsets", () => {
    expect(spanProblem(docs, { doc_id: "D1", start: 8, end: 19, quote: "two colours" })).toBeNull();
    expect(spanProblem(docs, { doc_id: "D1", start: 9, end: 20, quote: "two colours" })).toMatch(/not verbatim/);
    expect(spanProblem(docs, { doc_id: "D9", start: 0, end: 1, quote: "L" })).toMatch(/unknown doc/);
    expect(spanProblem(docs, { doc_id: "D1", start: 0, end: 999, quote: "x" })).toMatch(/out of range/);
  });
});

describe("Cohen's kappa", () => {
  it("is 1 for perfect agreement and matches a worked example", () => {
    expect(cohensKappa([["met", "met"], ["missing", "missing"]]).kappa).toBe(1);
    // po = 0.7, pe = 0.5*0.6 + 0.5*0.4 = 0.5 -> kappa = 0.4
    const pairs = [
      ...Array<["met", "met"]>(4).fill(["met", "met"]),
      ...Array<["met", "missing"]>(1).fill(["met", "missing"]),
      ...Array<["missing", "met"]>(2).fill(["missing", "met"]),
      ...Array<["missing", "missing"]>(3).fill(["missing", "missing"]),
    ];
    const k = cohensKappa(pairs);
    expect(k.po).toBeCloseTo(0.7);
    expect(k.kappa).toBeCloseTo(0.4);
    expect(cohensKappa([]).n).toBe(0);
  });
});

describe("PII scan", () => {
  it("allows the reserved synthetic patterns", () => {
    const ok = "Mail ama@example.test or kofi@example.com, call +254-00000-12345. Ref SYNTH-CAPTURE-0001, tracking EE123456789IN, 1Z9X8Y7W6V5U4T3S2R, INR 3,200 on 2026-11-03.";
    expect(scanText(ok)).toEqual([]);
  });

  it("flags real-looking emails, phones and PayPal ids", () => {
    const kinds = scanText("ama@gmail.com +91 98765 43210 9876543210 2GG279541U471931P").map((f) => f.kind);
    expect(kinds).toEqual(["email", "phone", "phone", "paypal_id"]);
  });
});

describe("spend ledger", () => {
  it("appends one row per model and sums per UTC day", () => {
    const file = join(mkdtempSync(join(tmpdir(), "spend-")), "SPEND.md");
    const ledger = createSpendLedger(file);
    ledger.add("m1", { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 }, 0.5);
    ledger.add("m1", null, 0.25);
    ledger.add("m2", null, 0.125);
    ledger.flush("eval:draft", new Date("2026-11-03T10:00:00Z"));
    ledger.flush("eval:draft", new Date("2026-11-03T11:00:00Z")); // nothing new: no row
    const md = readFileSync(file, "utf8");
    expect(md).toContain("| 2026-11-03 | eval:draft | m1 | 2 | 100 | 0 | 10 | 0 | 0.7500 |");
    expect(spendByDay(md).get("2026-11-03")).toBeCloseTo(0.875);
  });
});
