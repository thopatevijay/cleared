// Verbatim-quote check (ADR 0009): the citation guarantee for OpenAI output lives here, not in the
// model. A quote counts only if it appears verbatim in the evidence item it cites.
//
// Normalisation is deliberately narrow and applied identically to quote and evidence (M2-04):
//   1. Unicode NFC (composed and decomposed forms of the same character compare equal)
//   2. `\r\n` and lone `\r` become `\n`
//   3. curly quote marks become straight ones (‘ ’ ‚ ‛ → '   “ ” „ ‟ → ")
//   4. every run of Unicode whitespace (incl. NBSP, tabs, newlines) collapses to one ASCII space
//   5. leading and trailing whitespace of the quote is ignored
// Nothing else: no case folding, no dash folding, no punctuation stripping. A paraphrase or a changed
// word is unverifiable.
//
// Two APIs share these rules:
// - `verifyCitation` (M2-04, the scope check): offsets are into the NORMALISED item text, so
//   `normaliseForQuote(text).slice(start, end) === quote` for every stored citation; length limits apply.
// - `checkQuote` / `checkQuotes` (M0-07 spike API): offsets are into the ORIGINAL text; no length limits.

export interface EvidenceText {
  readonly id: string;
  readonly text: string;
}

export interface QuoteRef {
  readonly evidenceId: string;
  readonly quote: string;
}

export type QuoteCheck =
  | {
      readonly status: "verified";
      readonly evidenceId: string;
      readonly quote: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly status: "unverifiable";
      readonly evidenceId: string;
      readonly quote: string;
      readonly reason: UnverifiableReason;
    };

export type UnverifiableReason = "empty_quote" | "unknown_evidence" | "not_found";

interface Normalised {
  readonly text: string;
  /** map[i] = offset in the original string of normalised char i; map[text.length] = original end */
  readonly map: readonly number[];
}

const WHITESPACE = /\s/u;
const SINGLE_QUOTES = /[‘’‚‛]/g;
const DOUBLE_QUOTES = /[“”„‟]/g;

/** Curly → straight quote marks. Each mark is one UTF-16 unit on both sides, so offsets are unchanged. */
function foldQuoteMarks(s: string): string {
  return s.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"');
}

/** Collapses whitespace runs to one space, keeping a map back to offsets in the input. */
export function collapseWhitespace(input: string): Normalised {
  let text = "";
  const map: number[] = [];
  let inSpace = false;
  let offset = 0;
  for (const cp of input) {
    const isSpace = WHITESPACE.test(cp);
    if (!isSpace || !inSpace) {
      text += isSpace ? " " : cp;
      for (let k = 0; k < (isSpace ? 1 : cp.length); k += 1) map.push(offset + k);
    }
    inSpace = isSpace;
    offset += cp.length;
  }
  map.push(offset);
  return { text, map };
}

/** The scope check's normal form (rules 1–4). The quote side is also trimmed (rule 5). */
export function normaliseForQuote(s: string): string {
  return collapseWhitespace(foldQuoteMarks(s.normalize("NFC").replace(/\r\n?/g, "\n"))).text;
}

export function checkQuote(ref: QuoteRef, evidence: ReadonlyMap<string, string>): QuoteCheck {
  const { evidenceId, quote } = ref;
  const needle = collapseWhitespace(foldQuoteMarks(quote.normalize("NFC"))).text.trim();
  if (needle.length === 0) return { status: "unverifiable", evidenceId, quote, reason: "empty_quote" };
  const source = evidence.get(evidenceId);
  if (source === undefined) return { status: "unverifiable", evidenceId, quote, reason: "unknown_evidence" };

  const nfcSource = source.normalize("NFC");
  const hay = collapseWhitespace(foldQuoteMarks(nfcSource));
  const at = hay.text.indexOf(needle);
  if (at < 0) return { status: "unverifiable", evidenceId, quote, reason: "not_found" };

  // Offsets are reported against the original text; NFC may change lengths, so only when the
  // source is already NFC can the map be used directly. Otherwise map through the NFC string.
  const startNfc = hay.map[at] ?? 0;
  const endNfc = hay.map[at + needle.length] ?? nfcSource.length;
  if (nfcSource === source) return { status: "verified", evidenceId, quote, start: startNfc, end: endNfc };
  return { status: "verified", evidenceId, quote, ...mapNfcOffsets(source, startNfc, endNfc) };
}

/** Maps offsets in NFC(source) back to source by normalising code-point prefixes. */
function mapNfcOffsets(source: string, startNfc: number, endNfc: number): { start: number; end: number } {
  let start = -1;
  let end = source.length;
  let pos = 0;
  for (const cp of source) {
    const prefixLen = source.slice(0, pos).normalize("NFC").length;
    if (start < 0 && prefixLen >= startNfc) start = pos;
    if (prefixLen >= endNfc) {
      end = pos;
      break;
    }
    pos += cp.length;
  }
  return { start: start < 0 ? 0 : start, end };
}

/** Checks every quote; the evidence list is indexed by id once. */
export function checkQuotes(refs: readonly QuoteRef[], evidence: readonly EvidenceText[]): QuoteCheck[] {
  const index = new Map(evidence.map((e) => [e.id, e.text] as const));
  return refs.map((ref) => checkQuote(ref, index));
}

// ---- M2-04: citations for the scope check ------------------------------------------------------------

/** A quote shorter than this matches by chance ("Home", "5 items"); longer than the max is not a span. */
export const QUOTE_MIN_CHARS = 8;
export const QUOTE_MAX_CHARS = 500;

export const CITATION_REJECTIONS = [
  "empty_quote",
  "too_short",
  "too_long",
  "unknown_evidence",
  "no_text",
  "not_found",
] as const;
export type CitationRejection = (typeof CITATION_REJECTIONS)[number];

/** One stored item the model may cite, by its block ref (`E1`). `text` is null for an image. */
export interface CitableItem {
  readonly ref: string;
  readonly sha256: string;
  readonly text: string | null;
}

/** Items indexed by ref, each text normalised once. */
export type CitationIndex = ReadonlyMap<string, { readonly sha256: string; readonly norm: string | null }>;

export function citationIndex(items: readonly CitableItem[]): CitationIndex {
  return new Map(
    items.map((i) => [i.ref, { sha256: i.sha256, norm: i.text === null ? null : normaliseForQuote(i.text) }]),
  );
}

export type CitationCheck =
  | {
      readonly ok: true;
      readonly ref: string;
      /** the normalised quote: exactly `normaliseForQuote(item.text).slice(start, end)` */
      readonly quote: string;
      readonly start: number;
      readonly end: number;
      readonly sha256: string;
    }
  | { readonly ok: false; readonly ref: string; readonly reason: CitationRejection };

/** The verbatim rule for one citation: the normalised quote must occur in that item's normalised text. */
export function verifyCitation(ref: string, quote: string, index: CitationIndex): CitationCheck {
  const needle = normaliseForQuote(quote).trim();
  const len = Array.from(needle).length; // code points: an emoji or a CJK character counts once
  if (len === 0) return { ok: false, ref, reason: "empty_quote" };
  if (len < QUOTE_MIN_CHARS) return { ok: false, ref, reason: "too_short" };
  if (len > QUOTE_MAX_CHARS) return { ok: false, ref, reason: "too_long" };
  const item = index.get(ref);
  if (item === undefined) return { ok: false, ref, reason: "unknown_evidence" };
  if (item.norm === null) return { ok: false, ref, reason: "no_text" };
  const start = item.norm.indexOf(needle);
  if (start < 0) return { ok: false, ref, reason: "not_found" };
  return { ok: true, ref, quote: needle, start, end: start + needle.length, sha256: item.sha256 };
}
