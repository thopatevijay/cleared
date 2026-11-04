// Scoring (M4-02): code assertions first. Pure functions over gold items and workflow outputs.
// - extraction: field-level exact or normalised match against the extracted facts
// - scope: model lines matched to gold lines, label accuracy, per-label precision/recall, macro-F1,
//   span overlap (token IoU ≥ 0.5), citation verbatim rate
// - statistics: Wilson 95% interval, percentiles
import type { CheckedLine, Facts } from "@cleared/core";
import { normaliseForQuote } from "@cleared/core/proof/verbatim";
import { LABELS, type GoldHypothesis, type GoldItem, type Label, type Span } from "./gold/schema.ts";

// ---- statistics ----------------------------------------------------------------------------------------

export interface Rate {
  readonly k: number;
  readonly n: number;
  /** k / n (0 when n = 0) */
  readonly rate: number;
  /** Wilson score interval, 95% */
  readonly ci95: readonly [number, number];
}

const Z95 = 1.959963984540054;

export function wilson(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, ci95: [0, 0] };
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, rate: p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}

/** Nearest-rank percentile (p in 0..100); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

export type Predicted = Label | "none";

export interface LabelStats {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** gold count */
  readonly support: number;
}

/** Per-label precision/recall/F1 over (gold, predicted) pairs, and their unweighted mean F1. */
export function perLabel(pairs: readonly (readonly [Label, Predicted])[]): {
  labels: Record<Label, LabelStats>;
  macroF1: number;
} {
  const labels = {} as Record<Label, LabelStats>;
  for (const l of LABELS) {
    const tp = pairs.filter(([g, p]) => g === l && p === l).length;
    const predicted = pairs.filter(([, p]) => p === l).length;
    const support = pairs.filter(([g]) => g === l).length;
    const precision = predicted === 0 ? 0 : tp / predicted;
    const recall = support === 0 ? 0 : tp / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    labels[l] = { precision, recall, f1, support };
  }
  const present = LABELS.filter((l) => labels[l].support > 0);
  const macroF1 = present.length === 0 ? 0 : present.reduce((a, l) => a + labels[l].f1, 0) / present.length;
  return { labels, macroF1 };
}

// ---- text ----------------------------------------------------------------------------------------------

/** Lower-case word tokens (letters and digits of any script), quote marks and spacing folded. */
export function tokens(text: string): string[] {
  return normaliseForQuote(text).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

const STOP = new Set(["a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "with", "as", "is", "be"]);
const content = (text: string): string[] => tokens(text).filter((t) => !STOP.has(t));

/** Share of `needle`'s content tokens found in `hay` (0..1). */
export function containment(needle: string, hay: string): number {
  const want = content(needle);
  if (want.length === 0) return 0;
  const have = new Set(content(hay));
  return want.filter((t) => have.has(t)).length / want.length;
}

/** Token indexes covered by [start, end) of `text`. */
function tokenIndexes(text: string, start: number, end: number): Set<number> {
  const out = new Set<number>();
  let i = 0;
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const s = m.index;
    const e = s + m[0].length;
    if (s < end && start < e) out.add(i);
    i += 1;
  }
  return out;
}

/** Token IoU of two character spans over the same document text. */
export function tokenIoU(text: string, a: readonly [number, number], b: readonly [number, number]): number {
  const x = tokenIndexes(text, a[0], a[1]);
  const y = tokenIndexes(text, b[0], b[1]);
  const inter = [...x].filter((t) => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : inter / union;
}

// ---- extraction ----------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "20 September 2025" / "September 20, 2025" / "2025-09-20" → "2025-09-20"; null when not a full date. */
export function isoDateOf(text: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1] ?? ""}-${iso[2] ?? ""}-${iso[3] ?? ""}`;
  const t = text.toLowerCase();
  const dm = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s+(\d{4})/.exec(t);
  const md = /([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(t);
  const parts = dm ? { d: dm[1], m: dm[2], y: dm[3] } : md ? { d: md[2], m: md[1], y: md[3] } : null;
  if (!parts?.d || !parts.m || !parts.y) return null;
  const month = MONTHS.indexOf(parts.m.slice(0, 3));
  if (month < 0) return null;
  return `${parts.y}-${String(month + 1).padStart(2, "0")}-${parts.d.padStart(2, "0")}`;
}

/** "EUR 480" / "480 EUR" / "USD 1,250.00" → { currency, value } */
export function amountOf(text: string): { currency: string; value: number } | null {
  const cur = /\b([A-Z]{3})\b/.exec(text)?.[1];
  const num = /(\d[\d,]*(?:\.\d+)?)/.exec(text)?.[1];
  if (!cur || !num) return null;
  return { currency: cur, value: Number(num.replace(/,/g, "")) };
}

const squash = (s: string): string => tokens(s).join(" ");
const alnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Every extracted fact of one item, merged over its documents. */
export function mergeFacts(list: readonly Facts[]): Facts {
  return {
    parties: list.flatMap((f) => f.parties),
    amounts: list.flatMap((f) => f.amounts),
    dates: list.flatMap((f) => f.dates),
    deliverables: list.flatMap((f) => f.deliverables),
    delivery_events: list.flatMap((f) => f.delivery_events),
    shipment: list.find((f) => f.shipment !== null)?.shipment ?? null,
    instruction_like_lines: list.flatMap((f) => f.instruction_like_lines),
  };
}

/** Whether the facts carry the hypothesis's value for its field (normalised match per field). */
export function factFound(h: GoldHypothesis, facts: Facts, shipments: readonly NonNullable<Facts["shipment"]>[]): boolean {
  const value = h.value ?? "";
  switch (h.field) {
    case "amount": {
      const want = amountOf(value);
      return want !== null && facts.amounts.some((a) => a.currency === want.currency && Number(a.value) === want.value);
    }
    case "date": {
      const want = isoDateOf(value);
      if (want !== null) return facts.dates.some((d) => d.date.slice(0, 10) === want);
      return facts.dates.some((d) => containment(value, `${d.refers_to} ${d.source_quote}`) >= 0.8);
    }
    case "party":
      return facts.parties.some((p) => squash(p.name).includes(squash(value)) && squash(value) !== "");
    case "deliverable":
      return facts.deliverables.some((d) => containment(value, `${d.description} ${d.source_quote}`) >= 0.8);
    case "tracking_number":
      return shipments.some((s) => alnum(s.tracking_number) === alnum(value) && alnum(value) !== "");
    case "carrier":
      return shipments.some((s) => {
        const a = squash(s.carrier);
        const b = squash(value);
        return b !== "" && (a.includes(b) || b.includes(a));
      });
    default:
      return false;
  }
}

/** The hypothesis's qualifier ("Date: delivery deadline" → "delivery deadline"). */
const qualifier = (h: GoldHypothesis): string => h.text.replace(/^[^:]*:\s*/, "");

/**
 * A fact the gold says is absent (`missing` / `unverifiable`, no value) counts as wrongly extracted when the
 * model reports a fact of that field about the same thing (≥ half the qualifier's content words).
 */
export function absentFactReported(h: GoldHypothesis, facts: Facts, shipments: readonly NonNullable<Facts["shipment"]>[]): boolean {
  const q = qualifier(h);
  const about = (text: string): boolean => containment(q, text) >= 0.5;
  switch (h.field) {
    case "amount":
      return facts.amounts.some((a) => about(`${a.refers_to} ${a.source_quote}`));
    case "date":
      return facts.dates.some((d) => about(`${d.refers_to} ${d.source_quote}`));
    case "party":
      return facts.parties.some((p) => about(`${p.role} ${p.name} ${p.source_quote}`));
    case "deliverable":
      return facts.deliverables.some((d) => about(`${d.description} ${d.source_quote}`));
    case "tracking_number":
    case "carrier":
      return shipments.length > 0;
    default:
      return false;
  }
}

/** Extraction verdict per hypothesis: correct when found ⇔ the gold label is met / partial. */
export function scoreExtraction(item: GoldItem, perDoc: readonly Facts[]): { h_id: string; label: Label; found: boolean; correct: boolean }[] {
  const facts = mergeFacts(perDoc);
  const shipments = perDoc.flatMap((f) => (f.shipment ? [f.shipment] : []));
  return item.hypotheses.map((h) => {
    const supported = h.label === "met" || h.label === "partial";
    const found = h.value !== null ? factFound(h, facts, shipments) : absentFactReported(h, facts, shipments);
    const correct = h.value !== null ? found === supported : !found && !supported;
    return { h_id: h.h_id, label: h.label, found, correct };
  });
}

// ---- scope ---------------------------------------------------------------------------------------------

export interface LineMatch {
  readonly h_id: string;
  readonly line_id: string | null;
  readonly score: number;
}

/** Text a model line is matched on: its requirement and its verified scope quote. */
const lineText = (l: CheckedLine): string => `${l.requirement} ${l.line_citation?.quote ?? ""}`;

export const MATCH_MIN = 0.5;

/** Greedy one-to-one matching of gold lines to model lines by content-token containment (≥ 0.5). */
export function matchLines(hyps: readonly GoldHypothesis[], lines: readonly CheckedLine[]): LineMatch[] {
  const cands: { h: string; l: string; s: number }[] = [];
  for (const h of hyps)
    for (const l of lines) {
      const s = Math.max(containment(h.text, lineText(l)), containment(l.requirement, h.text));
      if (s >= MATCH_MIN) cands.push({ h: h.h_id, l: l.line_id, s });
    }
  cands.sort((a, b) => b.s - a.s || a.h.localeCompare(b.h) || a.l.localeCompare(b.l));
  const usedH = new Set<string>();
  const usedL = new Set<string>();
  const out = new Map<string, LineMatch>();
  for (const c of cands) {
    if (usedH.has(c.h) || usedL.has(c.l)) continue;
    usedH.add(c.h);
    usedL.add(c.l);
    out.set(c.h, { h_id: c.h, line_id: c.l, score: c.s });
  }
  return hyps.map((h) => out.get(h.h_id) ?? { h_id: h.h_id, line_id: null, score: 0 });
}

export interface ScopeHypScore {
  readonly h_id: string;
  readonly gold: Label;
  readonly predicted: Predicted;
  readonly line_id: string | null;
  /** met/partial on both sides: some model citation overlaps a gold span with token IoU ≥ 0.5 (null: n/a) */
  readonly spanMatch: boolean | null;
}

export const SPAN_IOU_MIN = 0.5;

export function scoreScope(
  item: GoldItem,
  lines: readonly CheckedLine[],
  docOfRef: ReadonlyMap<string, string>,
): ScopeHypScore[] {
  const matches = matchLines(item.hypotheses, lines);
  // model offsets are in the normalised text (verbatim.ts); gold spans are mapped there by their quote
  const normOf = new Map(item.documents.map((d) => [d.doc_id, normaliseForQuote(d.text)] as const));
  const goldSpan = (g: Span): readonly [number, number] | null => {
    const norm = normOf.get(g.doc_id);
    const q = normaliseForQuote(g.quote).trim();
    const at = norm?.indexOf(q) ?? -1;
    return at < 0 ? null : [at, at + q.length];
  };
  return item.hypotheses.map((h, i) => {
    const m = matches[i];
    const line = lines.find((l) => l.line_id === m?.line_id) ?? null;
    const predicted: Predicted = line?.verdict ?? "none";
    const supported = (x: Predicted): boolean => x === "met" || x === "partial";
    let spanMatch: boolean | null = null;
    if (line && supported(h.label) && supported(predicted)) {
      spanMatch = line.citations.some((c) =>
        h.spans.some((g: Span) => {
          const doc = docOfRef.get(c.evidence_ref);
          const text = doc ? normOf.get(doc) : undefined;
          const gs = goldSpan(g);
          return doc === g.doc_id && text !== undefined && gs !== null && tokenIoU(text, [c.start, c.end], gs) >= SPAN_IOU_MIN;
        }),
      );
    }
    return { h_id: h.h_id, gold: h.label, predicted, line_id: line?.line_id ?? null, spanMatch };
  });
}

export interface CitationAudit {
  /** stored citations whose quote is verbatim at its offsets in the item's text (offsets are in the text
   * normalised for quote marks and spacing, as verbatim.ts stores them) */
  readonly verbatim: number;
  readonly stored: number;
  /** met / partial lines without any stored citation (must be 0: uncited means unverifiable) */
  readonly uncitedSupported: number;
  /** citations dropped because the item has no text (screenshot-only: would be a 'visual' citation) */
  readonly visual: number;
  /** model quotes the verbatim check dropped (not found, wrong kind, instruction-like) */
  readonly dropped: number;
}

export function auditCitations(lines: readonly CheckedLine[], textOfRef: ReadonlyMap<string, string>): CitationAudit {
  let verbatim = 0;
  let stored = 0;
  let uncitedSupported = 0;
  let visual = 0;
  let dropped = 0;
  for (const l of lines) {
    if ((l.verdict === "met" || l.verdict === "partial") && l.citations.length === 0) uncitedSupported += 1;
    for (const c of [...l.citations, ...(l.line_citation ? [l.line_citation] : [])]) {
      stored += 1;
      const text = textOfRef.get(c.evidence_ref);
      if (text !== undefined && c.quote.length > 0 && normaliseForQuote(text).slice(c.start, c.end) === c.quote)
        verbatim += 1;
    }
    for (const d of l.dropped) {
      if (d.reason === "no_text") visual += 1;
      else dropped += 1;
    }
  }
  return { verbatim, stored, uncitedSupported, visual, dropped };
}

// ---- holds ---------------------------------------------------------------------------------------------

export interface HoldFactScore {
  readonly h_id: string;
  readonly fact_code: string | null;
  readonly label: Label;
  /** the judge's call; null when the judge gave none */
  readonly conveyed: boolean | null;
  readonly correct: boolean;
}

export interface HoldScore {
  readonly ruleOk: boolean;
  readonly languageOk: boolean;
  /** forbidden-claim codes found in the model's answer (must be empty) */
  readonly forbidden: readonly string[];
  /** per hypothesis: conveyed (judge) vs required (gold met / partial) */
  readonly facts: readonly HoldFactScore[];
  /** the model's own answer was shown (not the standard fallback text) */
  readonly ai: boolean;
  readonly pass: boolean;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const SELLER_WON = /\b(won|wins|win the (case|dispute))\b|जीत/i;

/** Maps the explain_hold guardrail codes to the gold set's forbidden-claim codes, plus `seller_won`. */
export function forbiddenClaims(problems: readonly string[], text: string): string[] {
  const out = new Set<string>();
  for (const p of problems) {
    if (p.startsWith("promise_word")) out.add("guaranteed_release");
    if (p.startsWith("date_expression")) out.add("exact_release_date");
  }
  if (SELLER_WON.test(text)) out.add("seller_won");
  return [...out].sort();
}

export interface HoldScoreInput {
  readonly item: GoldItem;
  readonly expectedRuleId: string;
  /** the rule row the stored explanation cites */
  readonly shownRuleId: string;
  /** the model's `ruleId` (null when the standard text was used) */
  readonly modelRuleId: string | null;
  /** the explanation as shown (slots filled) */
  readonly text: string;
  /** explain_hold guardrail problems on the model's raw answer */
  readonly guardrailProblems: readonly string[];
  readonly conveyed: ReadonlyMap<string, boolean>;
  readonly ai: boolean;
}

export function scoreHold(a: HoldScoreInput): HoldScore {
  const ruleOk = a.shownRuleId === a.expectedRuleId && (a.modelRuleId ?? a.shownRuleId) === a.expectedRuleId;
  const hasDeva = DEVANAGARI.test(a.text);
  const languageOk = a.item.locale === "hi" ? hasDeva : !hasDeva;
  const forbidden = forbiddenClaims(a.guardrailProblems, a.text);
  const facts = a.item.hypotheses.map((h): HoldFactScore => {
    const conveyed = a.conveyed.get(h.h_id) ?? null;
    const required = h.label === "met" || h.label === "partial";
    return { h_id: h.h_id, fact_code: h.fact_code, label: h.label, conveyed, correct: conveyed !== null && conveyed === required };
  });
  const pass = a.ai && ruleOk && languageOk && forbidden.length === 0 && facts.every((f) => f.correct);
  return { ruleOk, languageOk, forbidden, facts, ai: a.ai, pass };
}

/** EN/HI fact parity (BL-01 6570430484): both items of a pair convey the same fact codes. */
export function factParity(en: HoldScore, hi: HoldScore): boolean {
  const set = (s: HoldScore): string =>
    s.facts
      .filter((f) => f.conveyed === true)
      .map((f) => f.fact_code ?? f.h_id)
      .sort()
      .join(",");
  return set(en) === set(hi);
}
