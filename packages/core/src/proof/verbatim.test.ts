import { describe, expect, it } from "vitest";
import {
  checkQuote,
  checkQuotes,
  citationIndex,
  collapseWhitespace,
  normaliseForQuote,
  QUOTE_MAX_CHARS,
  verifyCitation,
} from "./verbatim.ts";

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

  it("fails a near miss with different case; curly and straight quote marks compare equal (M2-04)", () => {
    expect(checkQuote({ evidenceId: "E1", quote: "three colour variants" }, evidence).status).toBe(
      "unverifiable",
    );
    const q = new Map([["Q", 'He said "done"']]);
    expect(checkQuote({ evidenceId: "Q", quote: "He said “done”" }, q).status).toBe("verified");
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

// ---- M2-04: verifyCitation (the scope check's rule; offsets into the normalised text) -----------------

const SHA1 = "1".repeat(64);
const SHA2 = "2".repeat(64);
const delivery =
  "Files delivered\r\nnorthwind-logo.svg (primary logo, vector)\r\nThe client said “perfect, approved” and   the ‘black’ version ships.";
const chatItem = "[2026-10-19 12:02] Meera Studio: Sure, I will send the .ai file tomorrow.";
const idx = citationIndex([
  { ref: "E1", sha256: SHA1, text: delivery },
  { ref: "E2", sha256: SHA2, text: chatItem },
  { ref: "E3", sha256: SHA1, text: null },
]);

function sliceOk(ref: string, quote: string): void {
  const r = verifyCitation(ref, quote, idx);
  if (!r.ok) throw new Error(`expected ${quote} to verify, got ${r.reason}`);
  const text = ref === "E1" ? delivery : chatItem;
  expect(normaliseForQuote(text).slice(r.start, r.end)).toBe(r.quote);
  expect(r.quote).toBe(normaliseForQuote(quote).trim());
  expect(r.sha256).toBe(ref === "E1" ? SHA1 : SHA2);
}

describe("verifyCitation (M2-04 AC 1)", () => {
  it("an exact quote passes, with offsets into the normalised text and the item sha256", () => {
    sliceOk("E2", "Sure, I will send the .ai file tomorrow.");
  });

  it("whitespace, curly-quote and CRLF variants pass", () => {
    sliceOk("E1", "Files delivered\nnorthwind-logo.svg (primary logo, vector)"); // LF vs the stored CRLF
    sliceOk("E1", "Files delivered northwind-logo.svg"); // a space vs the stored line break
    sliceOk("E1", 'The client said "perfect, approved" and the'); // straight vs curly, collapsed spaces
    sliceOk("E1", "the 'black' version ships."); // straight vs curly single marks
    sliceOk("E1", "  the ‘black’\tversion ships.\r\n"); // tab, trailing CRLF, outer spaces
  });

  it("a paraphrase fails", () => {
    expect(verifyCitation("E2", "I will send the Illustrator file tomorrow.", idx)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("a quote from a different item fails", () => {
    expect(verifyCitation("E1", "Sure, I will send the .ai file tomorrow.", idx)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("a quote spanning two items fails", () => {
    const joined = "the 'black' version ships. [2026-10-19 12:02] Meera Studio: Sure";
    expect(verifyCitation("E1", joined, idx)).toMatchObject({ ok: false, reason: "not_found" });
    expect(verifyCitation("E2", joined, idx)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("a 5-char quote fails (too short), as does one over 500 chars", () => {
    expect(verifyCitation("E1", "Files", idx)).toMatchObject({ ok: false, reason: "too_short" });
    expect(verifyCitation("E1", "x".repeat(QUOTE_MAX_CHARS + 1), idx)).toMatchObject({
      ok: false,
      reason: "too_long",
    });
  });

  it("an empty quote, an unknown ref and an image (no text) fail with their own reasons", () => {
    expect(verifyCitation("E1", " \n ", idx)).toMatchObject({ ok: false, reason: "empty_quote" });
    expect(verifyCitation("E9", "Files delivered", idx)).toMatchObject({
      ok: false,
      reason: "unknown_evidence",
    });
    expect(verifyCitation("E3", "Files delivered", idx)).toMatchObject({ ok: false, reason: "no_text" });
  });

  it("normalises NFD to NFC on both sides", () => {
    const nfd = "Café menu redesign, two rounds";
    const i = citationIndex([{ ref: "E1", sha256: SHA1, text: nfd }]);
    expect(verifyCitation("E1", "Café menu redesign", i).ok).toBe(true);
  });
});

/** Seeded PRNG (mulberry32): the property test is deterministic and needs no extra dependency. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "B", "7", " ", "  ", "\t", "\r\n", "\n", " ", "’", "'", "“", '"', "é", "é", "-", "."];

describe("verifyCitation property (M2-04 AC 3)", () => {
  it("every verified span slices the normalised text to exactly the normalised quote (2,000 cases)", () => {
    const next = rng(20261031);
    const pick = (n: number): number => Math.floor(next() * n);
    let verified = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const parts = Array.from({ length: 20 + pick(80) }, () => ALPHABET[pick(ALPHABET.length)] ?? "a");
      const text = parts.join("");
      const from = pick(text.length);
      const quote = text.slice(from, from + 8 + pick(40));
      const r = verifyCitation("E1", quote, citationIndex([{ ref: "E1", sha256: SHA1, text }]));
      if (!r.ok) {
        // a substring is refused only by the length rules, or when the cut splits a CRLF / combining pair
        expect(["too_short", "empty_quote", "not_found"]).toContain(r.reason);
        continue;
      }
      verified += 1;
      expect(normaliseForQuote(text).slice(r.start, r.end)).toBe(r.quote);
      expect(r.quote).toBe(normaliseForQuote(quote).trim());
    }
    expect(verified).toBeGreaterThan(1_000);
  });
});
