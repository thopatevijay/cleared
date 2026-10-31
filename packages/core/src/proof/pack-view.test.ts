import { describe, expect, it } from "vitest";
import {
  isProofReady,
  packSummary,
  packViewSettled,
  packViewState,
  quoteInContext,
  type PackViewInput,
  type SummaryLine,
} from "./pack-view.ts";
import { normaliseForQuote } from "./verbatim.ts";

const T = (s: number): Date => new Date(Date.UTC(2026, 9, 31, 10, 0, s));
const base: PackViewInput = {
  state: "collecting",
  kinds: ["delivery"],
  newestItemAt: T(10),
  unavailable: null,
  lastExtractionFailed: null,
};

describe("packViewState (M2-05 banner)", () => {
  it("empty, collecting without a scope source, checking with one", () => {
    expect(packViewState({ ...base, state: "empty", kinds: [], newestItemAt: null })).toBe("empty");
    expect(packViewState(base)).toBe("collecting");
    expect(packViewState({ ...base, kinds: ["delivery", "communication"] })).toBe("checking");
    expect(packViewState({ ...base, kinds: ["scope"] })).toBe("checking");
  });

  it("checked and ready show checked; stale stays stale", () => {
    expect(packViewState({ ...base, state: "checked", kinds: ["scope"] })).toBe("checked");
    expect(packViewState({ ...base, state: "ready", kinds: ["scope"] })).toBe("checked");
    expect(packViewState({ ...base, state: "stale", kinds: ["scope"] })).toBe("stale");
  });

  it("a check_unavailable entry newer than the newest item wins; an older one does not", () => {
    const s = { ...base, kinds: ["scope"] };
    expect(packViewState({ ...s, unavailable: { at: T(20), status: "degraded" } })).toBe("check_unavailable");
    expect(packViewState({ ...s, unavailable: { at: T(20), status: "budget_exceeded" } })).toBe(
      "budget_exceeded",
    );
    expect(packViewState({ ...s, unavailable: { at: T(5), status: "degraded" } })).toBe("checking");
  });

  it("BL-01 6537991625: a failed last extraction is shown, not an endless spinner", () => {
    const s = { ...base, state: "stale" as const, kinds: ["scope", "delivery"] };
    expect(packViewState({ ...s, lastExtractionFailed: { at: T(30), status: "failed_output" } })).toBe(
      "check_unavailable",
    );
    expect(packViewState({ ...s, lastExtractionFailed: { at: T(30), status: "budget_exceeded" } })).toBe(
      "budget_exceeded",
    );
  });

  it("polls only while the agent may still change the pack", () => {
    expect(["collecting", "checking", "stale"].map((s) => packViewSettled(s as never))).toEqual([
      false,
      false,
      false,
    ]);
    expect(
      ["empty", "checked", "check_unavailable", "budget_exceeded"].map((s) => packViewSettled(s as never)),
    ).toEqual([true, true, true, true]);
  });
});

const A = "6f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b";
const B = "7f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b";
const C = "8f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6b";
const line = (verdict: SummaryLine["verdict"], scope: string | null, cites: string[] = []): SummaryLine => ({
  verdict,
  lineCitation: scope === null ? null : { evidence_item_id: scope },
  citations: cites.map((evidence_item_id) => ({ evidence_item_id })),
});

describe("packSummary (dashboard.md element 6)", () => {
  it("all met with scope quotes: scope met · delivery met · distinct sources", () => {
    const s = packSummary([line("met", A, [B]), line("met", A, [B, C])]);
    expect(s).toEqual({
      scope: "met",
      delivery: "met",
      sources: 3,
      counts: { met: 2, partial: 0, missing: 0, unverifiable: 0 },
    });
  });

  it("the weakest delivery verdict wins; scope is partial when some lines lack a scope quote", () => {
    expect(packSummary([line("met", A, [B]), line("partial", null, [B])])).toMatchObject({
      scope: "partial",
      delivery: "partial",
      sources: 2,
    });
    expect(packSummary([line("partial", A, [B]), line("unverifiable", A)])?.delivery).toBe("unverifiable");
    expect(packSummary([line("unverifiable", A), line("missing", A, [C])])?.delivery).toBe("missing");
    expect(packSummary([line("met", null, [B])])?.scope).toBe("unverifiable");
  });

  it("no check yet: null", () => {
    expect(packSummary([])).toBeNull();
  });

  it("proof-ready: checked or ready with no missing line", () => {
    expect(isProofReady("checked", [{ verdict: "met" }, { verdict: "unverifiable" }])).toBe(true);
    expect(isProofReady("ready", [{ verdict: "partial" }])).toBe(true);
    expect(isProofReady("checked", [{ verdict: "met" }, { verdict: "missing" }])).toBe(false);
    expect(isProofReady("stale", [{ verdict: "met" }])).toBe(false);
    expect(isProofReady("collecting", [])).toBe(false);
  });
});

describe("quoteInContext", () => {
  const text = "Hi Meera,\r\n  can you do “3 concepts” + 2 revision rounds for $120? Thanks";

  it("cuts the quote at its offsets in the normalised text, with context on each side", () => {
    const norm = normaliseForQuote(text);
    const quote = 'can you do "3 concepts"';
    const start = norm.indexOf(quote);
    const q = quoteInContext(text, { start, end: start + quote.length }, quote, 5);
    expect(q).not.toBeNull();
    expect(q?.quote).toBe(quote);
    expect(q?.exact).toBe(true);
    expect(q?.before).toBe(`…${norm.slice(start - 5, start)}`);
    expect(q?.after).toBe(`${norm.slice(start + quote.length, start + quote.length + 5)}…`);
    expect(`${q?.before ?? ""}${q?.quote ?? ""}${q?.after ?? ""}`.replaceAll("…", "")).toBe(
      norm.slice(start - 5, start + quote.length + 5),
    );
  });

  it("no text, or offsets outside it: null; a slice that differs from the stored quote is not exact", () => {
    expect(quoteInContext(null, { start: 0, end: 3 }, "abc")).toBeNull();
    expect(quoteInContext("abc", { start: 2, end: 9 }, "c")).toBeNull();
    expect(quoteInContext("abc", { start: 2, end: 2 }, "")).toBeNull();
    expect(quoteInContext("abcdef", { start: 0, end: 3 }, "xyz")?.exact).toBe(false);
  });
});
