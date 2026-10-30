import { describe, expect, it } from "vitest";
import { checkQuote, checkQuotes, collapseWhitespace } from "../../src/proof/verbatim.ts";

const brief =
  "Deliverables:\n- Primary logo in SVG and PNG\n- Three colour variants\n- Final files by 15 Nov 2026";
const chat = "Client: Looks great, but  please   also send the\tSVG source.";
const evidence = new Map([
  ["E1", brief],
  ["E2", chat],
]);

describe("verbatim check", () => {
  it("passes an exact quote and returns offsets into the original text", () => {
    const r = checkQuote({ evidenceId: "E1", quote: "Three colour variants" }, evidence);
    expect(r).toEqual({
      status: "verified",
      evidenceId: "E1",
      quote: "Three colour variants",
      start: brief.indexOf("Three"),
      end: brief.indexOf("Three") + "Three colour variants".length,
    });
    if (r.status === "verified") expect(brief.slice(r.start, r.end)).toBe("Three colour variants");
  });

  it("matches across collapsed whitespace and maps offsets back to the original", () => {
    const r = checkQuote({ evidenceId: "E2", quote: "please also send the SVG source." }, evidence);
    expect(r.status).toBe("verified");
    if (r.status === "verified")
      expect(chat.slice(r.start, r.end)).toBe("please   also send the\tSVG source.");
  });

  it("ignores leading and trailing whitespace of the quote", () => {
    expect(checkQuote({ evidenceId: "E1", quote: "  Three colour variants\n" }, evidence).status).toBe(
      "verified",
    );
  });

  it("treats NFC and NFD forms as equal (Unicode normalisation only)", () => {
    const nfd = "Café menu redesign";
    const r = checkQuote({ evidenceId: "X", quote: "Café menu" }, new Map([["X", nfd]]));
    expect(r.status).toBe("verified");
    if (r.status === "verified") expect(nfd.slice(r.start, r.end)).toBe("Café menu");
  });

  it("fails a paraphrase", () => {
    const r = checkQuote({ evidenceId: "E1", quote: "Three color variants" }, evidence);
    expect(r).toMatchObject({ status: "unverifiable", reason: "not_found" });
  });

  it("fails a near miss with different case or quote marks", () => {
    expect(checkQuote({ evidenceId: "E1", quote: "three colour variants" }, evidence).status).toBe(
      "unverifiable",
    );
    const q = new Map([["Q", 'He said "done"']]);
    expect(checkQuote({ evidenceId: "Q", quote: "He said “done”" }, q).status).toBe("unverifiable");
  });

  it("fails a truncated-then-extended quote (text the evidence does not continue with)", () => {
    const r = checkQuote({ evidenceId: "E1", quote: "Final files by 15 Nov 2026 at noon" }, evidence);
    expect(r).toMatchObject({ status: "unverifiable", reason: "not_found" });
  });

  it("fails a quote with an ellipsis standing in for omitted words", () => {
    const r = checkQuote({ evidenceId: "E1", quote: "Primary logo ... PNG" }, evidence);
    expect(r.status).toBe("unverifiable");
  });

  it("fails a quote taken from another evidence item", () => {
    const r = checkQuote({ evidenceId: "E1", quote: "please also send the SVG source." }, evidence);
    expect(r).toMatchObject({ status: "unverifiable", reason: "not_found" });
  });

  it("fails an unknown evidence id and an empty quote", () => {
    expect(checkQuote({ evidenceId: "E9", quote: "Three" }, evidence)).toMatchObject({
      reason: "unknown_evidence",
    });
    expect(checkQuote({ evidenceId: "E1", quote: " \n " }, evidence)).toMatchObject({
      reason: "empty_quote",
    });
  });

  it("checks a list against an evidence array", () => {
    const out = checkQuotes(
      [
        { evidenceId: "E1", quote: "Primary logo in SVG and PNG" },
        { evidenceId: "E2", quote: "send the SVG" },
        { evidenceId: "E2", quote: "send the AI file" },
      ],
      [
        { id: "E1", text: brief },
        { id: "E2", text: chat },
      ],
    );
    expect(out.map((r) => r.status)).toEqual(["verified", "verified", "unverifiable"]);
  });

  it("collapses every whitespace kind, including NBSP", () => {
    expect(collapseWhitespace("a  b\n\tc").text).toBe("a b c");
  });
});
