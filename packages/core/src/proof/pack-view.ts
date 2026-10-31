// What the seller sees of a proof pack (M2-05): the banner state derived from the stored pack state and
// the agent's audit trail, the dashboard's one-line pack summary, and a citation's quote in context.
// Pure: the web app reads the rows and calls these.
import type { SellerEvidenceKind } from "./evidence.ts";
import type { PackState, Verdict } from "./pack.ts";
import { normaliseForQuote } from "./verbatim.ts";

/** The banner states of payment-detail.md (`checking` is derived: the stored machine has no such state). */
export const PACK_VIEW_STATES = [
  "empty",
  "collecting",
  "checking",
  "checked",
  "stale",
  "check_unavailable",
  "budget_exceeded",
] as const;
export type PackViewState = (typeof PACK_VIEW_STATES)[number];

/** Items the scope check reads its scope lines from (M2-04 `no_scope`: without one, no check runs). */
const SCOPE_SOURCES: ReadonlySet<string> = new Set(["scope", "scope_snapshot", "communication"]);

export interface PackViewInput {
  readonly state: PackState;
  readonly kinds: readonly string[];
  /** when the newest evidence item was added; null for an empty pack */
  readonly newestItemAt: Date | null;
  /** the newest `check_unavailable` audit entry for this pack, if any */
  readonly unavailable: { readonly at: Date; readonly status: string } | null;
  /**
   * The newest finished extraction when the pack's items have all finished and the last one ended without
   * facts (BL-01 6537991625: nothing re-triggers the check then); null otherwise.
   */
  readonly lastExtractionFailed: { readonly at: Date; readonly status: string } | null;
}

const unavailableState = (status: string): PackViewState =>
  status === "budget_exceeded" ? "budget_exceeded" : "check_unavailable";

/**
 * The banner state. A check that could not run after the newest item was added wins over
 * "checking": the seller sees facts without a verdict instead of a spinner that never ends.
 */
export function packViewState(p: PackViewInput): PackViewState {
  if (p.state === "empty" || p.kinds.length === 0) return "empty";
  if (p.state === "checked" || p.state === "ready") return "checked";
  const newest = p.newestItemAt?.getTime() ?? 0;
  if (p.unavailable !== null && p.unavailable.at.getTime() >= newest) {
    return unavailableState(p.unavailable.status);
  }
  if (p.lastExtractionFailed !== null && p.lastExtractionFailed.at.getTime() >= newest) {
    return unavailableState(p.lastExtractionFailed.status);
  }
  if (p.state === "stale") return "stale";
  return p.kinds.some((k) => SCOPE_SOURCES.has(k)) ? "checking" : "collecting";
}

/** The page polls while the agent may still change what it shows. */
export function packViewSettled(s: PackViewState): boolean {
  return !(s === "collecting" || s === "checking" || s === "stale");
}

/** One stored scope line, as far as the summary needs it. */
export interface SummaryLine {
  readonly verdict: Verdict;
  readonly lineCitation: { readonly evidence_item_id: string } | null;
  readonly citations: readonly { readonly evidence_item_id: string }[];
}

export interface PackSummary {
  /** is what was agreed backed by a verified quote? met (every line) · partial (some) · unverifiable (none) */
  readonly scope: Verdict;
  /** the weakest delivery verdict: missing, then unverifiable, then partial, then met */
  readonly delivery: Verdict;
  /** distinct evidence items cited by the check */
  readonly sources: number;
  readonly counts: Readonly<Record<Verdict, number>>;
}

const WEAKEST_FIRST: readonly Verdict[] = ["missing", "unverifiable", "partial", "met"];

/** The dashboard sub-line of one pack's latest check (dashboard.md element 6); null before a check. */
export function packSummary(lines: readonly SummaryLine[]): PackSummary | null {
  if (lines.length === 0) return null;
  const counts: Record<Verdict, number> = { met: 0, partial: 0, missing: 0, unverifiable: 0 };
  const sources = new Set<string>();
  let quoted = 0;
  for (const l of lines) {
    counts[l.verdict] += 1;
    if (l.lineCitation !== null) {
      quoted += 1;
      sources.add(l.lineCitation.evidence_item_id);
    }
    for (const c of l.citations) sources.add(c.evidence_item_id);
  }
  const scope: Verdict = quoted === lines.length ? "met" : quoted > 0 ? "partial" : "unverifiable";
  const delivery = WEAKEST_FIRST.find((v) => counts[v] > 0) ?? "met";
  return { scope, delivery, sources: sources.size, counts };
}

/** Proof-ready (dashboard.md 3c): checked (or marked ready) and no line of the latest check is missing. */
export function isProofReady(state: PackState, lines: readonly { readonly verdict: Verdict }[]): boolean {
  return (state === "checked" || state === "ready") && !lines.some((l) => l.verdict === "missing");
}

export interface QuoteInContext {
  readonly before: string;
  /** `normaliseForQuote(text).slice(start, end)`: what the highlight shows */
  readonly quote: string;
  readonly after: string;
  /** the slice equals the stored quote (always, for a row that passed M2-04's verbatim check) */
  readonly exact: boolean;
}

/** Context shown on each side of a highlighted quote. */
export const QUOTE_CONTEXT_CHARS = 80;

/**
 * The quoted span with up to `radius` characters of context, cut from the item text normalised the way
 * M2-04 computed the offsets. Null when the text is gone or the offsets do not fit it.
 */
export function quoteInContext(
  text: string | null,
  offsets: { readonly start: number; readonly end: number },
  stored: string,
  radius = QUOTE_CONTEXT_CHARS,
): QuoteInContext | null {
  if (text === null) return null;
  const norm = normaliseForQuote(text);
  const { start, end } = offsets;
  if (start < 0 || end <= start || end > norm.length) return null;
  const quote = norm.slice(start, end);
  const from = Math.max(0, start - radius);
  const to = Math.min(norm.length, end + radius);
  return {
    before: (from > 0 ? "…" : "") + norm.slice(from, start),
    quote,
    after: norm.slice(end, to) + (to < norm.length ? "…" : ""),
    exact: quote === stored,
  };
}

/** Kinds offered by the intake panel, in the order the selector lists them. */
export const INTAKE_KINDS: readonly SellerEvidenceKind[] = [
  "communication",
  "scope",
  "delivery",
  "shipment",
  "invoice",
];
