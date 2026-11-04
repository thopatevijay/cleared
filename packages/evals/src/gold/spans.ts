// Spans are selected by quote; offsets are computed, never typed. A span is valid only when
// `quote === text.slice(start, end)` of its document (AC 2).
import type { GoldDocument, Span } from "./schema.ts";

/** Every start offset of `quote` in `text`. */
export function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  if (quote === "") return found;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) found.push(i);
  return found;
}

export type Located =
  | { readonly kind: "ok"; readonly span: Span }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly places: readonly { doc_id: string; start: number }[] };

/**
 * Finds `quote` in the named document (or in all of them when `docId` is null). `pick` chooses among
 * several places (0-based, in document order); without it, more than one place is `ambiguous`.
 */
export function locateQuote(
  docs: readonly GoldDocument[],
  quote: string,
  docId: string | null = null,
  pick?: number,
): Located {
  const places = docs
    .filter((d) => docId === null || d.doc_id === docId)
    .flatMap((d) => occurrences(d.text, quote).map((start) => ({ doc_id: d.doc_id, start })));
  if (places.length === 0) return { kind: "not_found" };
  const chosen = places.length === 1 ? places[0] : pick === undefined ? undefined : places[pick];
  if (chosen === undefined) return { kind: "ambiguous", places };
  return { kind: "ok", span: { doc_id: chosen.doc_id, start: chosen.start, end: chosen.start + quote.length, quote } };
}

/** A problem with one span, or null when it is verbatim at its offsets. */
export function spanProblem(docs: readonly GoldDocument[], s: Span): string | null {
  const d = docs.find((x) => x.doc_id === s.doc_id);
  if (d === undefined) return `unknown doc ${s.doc_id}`;
  if (s.end <= s.start || s.end > d.text.length) return `offsets ${String(s.start)}-${String(s.end)} out of range`;
  return d.text.slice(s.start, s.end) === s.quote ? null : `quote is not verbatim at ${s.doc_id}:${String(s.start)}`;
}
