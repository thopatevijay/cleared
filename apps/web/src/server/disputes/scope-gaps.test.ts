// BL-01 6539398891: the approval card's scope gaps come from data (the check's verdicts and the draft's
// fact_refs), never from the notes' prose.
import { describe, expect, it } from "vitest";
import { scopeGaps } from "./read.ts";

const lines = [
  { lineId: "C1", line: "Primary logo in SVG.", verdict: "met" },
  { lineId: "C7", line: "Editable .ai source file.", verdict: "missing" },
  { lineId: "C8", line: "Two revision rounds.", verdict: "partial" },
  { lineId: "C9", line: "Brand guide.", verdict: "unverifiable" },
  { lineId: "C10", line: "Favicon set.", verdict: "missing" },
];
const ref = (r: string, kind = "line") => ({ ref: r, kind, evidence_item_id: null });

describe("scopeGaps", () => {
  it("keeps partial and missing lines a notes paragraph relies on, in the check's order", () => {
    const factRefs = [
      { paragraph: 1, refs: [ref("C8"), ref("C1")] },
      { paragraph: 2, refs: [ref("C7"), ref("C9"), ref("F2", "fact")] },
      { paragraph: 3, refs: [ref("C7")] },
    ];
    expect(scopeGaps(factRefs, lines)).toEqual([
      { lineId: "C7", requirement: "Editable .ai source file.", verdict: "missing" },
      { lineId: "C8", requirement: "Two revision rounds.", verdict: "partial" },
    ]);
  });

  it("ignores a gap the notes don't rely on (C10), met and unverifiable lines, and non-line refs", () => {
    expect(scopeGaps([{ paragraph: 1, refs: [ref("C1"), ref("C9"), ref("C10", "fact")] }], lines)).toEqual([]);
  });

  it("is empty for no fact refs or malformed jsonb", () => {
    expect(scopeGaps([], lines)).toEqual([]);
    expect(scopeGaps(null, lines)).toEqual([]);
    expect(scopeGaps([{ paragraph: 1, refs: [7, ref("C7")] }], lines)).toEqual([
      { lineId: "C7", requirement: "Editable .ai source file.", verdict: "missing" },
    ]);
  });
});
