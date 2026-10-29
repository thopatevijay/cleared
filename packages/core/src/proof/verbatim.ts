// Verbatim-quote check (ADR 0009): the citation guarantee for OpenAI output lives here, not in the
// model. A quote counts only if it appears verbatim in the evidence item it cites.
//
// Normalisation is deliberately narrow and applied identically to quote and evidence:
//   1. Unicode NFC (composed and decomposed forms of the same character compare equal)
//   2. every run of Unicode whitespace (incl. NBSP, tabs, newlines) collapses to one ASCII space
//   3. leading and trailing whitespace of the quote is ignored
// Nothing else: no case folding, no quote-mark or dash folding, no punctuation stripping. A
// paraphrase, a changed word or a "smart" quote the evidence does not contain is unverifiable.
// Offsets are UTF-16 code-unit offsets into the ORIGINAL evidence text, end exclusive.

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

export function checkQuote(ref: QuoteRef, evidence: ReadonlyMap<string, string>): QuoteCheck {
  const { evidenceId, quote } = ref;
  const needle = collapseWhitespace(quote.normalize("NFC")).text.trim();
  if (needle.length === 0) return { status: "unverifiable", evidenceId, quote, reason: "empty_quote" };
  const source = evidence.get(evidenceId);
  if (source === undefined) return { status: "unverifiable", evidenceId, quote, reason: "unknown_evidence" };

  const nfcSource = source.normalize("NFC");
  const hay = collapseWhitespace(nfcSource);
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
