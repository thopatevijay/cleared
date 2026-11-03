// The gold-set checks behind `pnpm eval:validate` (pure: data in, report out). Each check appends to
// `errors`; `lines` is what the command prints (counts, per-label coverage, kappa, spend).
import { holdRule } from "@cleared/core";
import { cohensKappa } from "./kappa.ts";
import { DEV_SHARE, splitFor } from "./plan.ts";
import { LABELS, PROD_MODEL, SET_SIZE, SETS, type Disagreement, type GoldItem, type GoldSet, type Label } from "./schema.ts";
import { spanProblem } from "./spans.ts";
import { DAILY_BUDGET_USD } from "./spend.ts";

export const MIN_SCOPE_ITEMS_PER_LABEL = 8;
export const MIN_INJECTION_ITEMS = 5;
export const HOLDS_PER_LOCALE = 10;
const SPLIT_TOLERANCE = 0.1;

export interface Report {
  readonly lines: string[];
  readonly errors: string[];
}

export type GoldSets = Readonly<Record<GoldSet, readonly GoldItem[]>>;

export function checkCounts(sets: GoldSets, draftIds: Readonly<Record<GoldSet, readonly string[]>>, r: Report): void {
  r.lines.push(`counts: ${SETS.map((s) => `${s}: ${String(sets[s].length)}`).join(" ")}`);
  for (const s of SETS) {
    if (sets[s].length !== SET_SIZE[s]) r.errors.push(`${s}: ${String(sets[s].length)} labelled items, expected ${String(SET_SIZE[s])}`);
    const ids = new Set(sets[s].map((i) => i.id));
    if (ids.size !== sets[s].length) r.errors.push(`${s}: duplicate item ids`);
    const notDrafted = [...ids].filter((id) => !draftIds[s].includes(id));
    if (notDrafted.length > 0) r.errors.push(`${s}: items not in the drafts: ${notDrafted.join(", ")}`);
  }
}

export function checkSplit(sets: GoldSets, r: Report): void {
  for (const s of SETS) {
    const items = sets[s];
    const wrong = items.filter((i) => i.split !== splitFor(i.hold?.pair_id ?? i.id));
    if (wrong.length > 0) r.errors.push(`${s}: split not from the seeded hash: ${wrong.map((i) => i.id).join(", ")}`);
    const dev = items.filter((i) => i.split === "dev").length / Math.max(1, items.length);
    r.lines.push(`split ${s}: dev ${(dev * 100).toFixed(1)}% / test ${((1 - dev) * 100).toFixed(1)}%`);
    if (items.length > 0 && Math.abs(dev - DEV_SHARE) > SPLIT_TOLERANCE) r.errors.push(`${s}: dev share ${dev.toFixed(2)} is not about ${String(DEV_SHARE)}`);
  }
}

/** AC 2: every span verbatim at its offsets; unverifiable has none; met/partial have at least one. */
export function checkSpans(sets: GoldSets, r: Report): void {
  let spans = 0;
  let mismatches = 0;
  for (const item of SETS.flatMap((s) => sets[s])) {
    for (const h of item.hypotheses) {
      const where = `${item.id}/${h.h_id}`;
      if (h.label === "unverifiable" && h.spans.length > 0) r.errors.push(`${where}: unverifiable has spans`);
      if ((h.label === "met" || h.label === "partial") && h.spans.length === 0) r.errors.push(`${where}: ${h.label} needs a span`);
      for (const s of h.spans) {
        spans += 1;
        const problem = spanProblem(item.documents, s);
        if (problem !== null) {
          mismatches += 1;
          r.errors.push(`${where}: ${problem}`);
        }
      }
    }
  }
  r.lines.push(`spans: ${String(spans)} checked, ${String(mismatches)} mismatches`);
}

export function checkCoverage(sets: GoldSets, r: Report): void {
  const per = LABELS.map((l) => [l, sets.scope.filter((i) => i.hypotheses.some((h) => h.label === l)).length] as const);
  r.lines.push(`scope items per label: ${per.map(([l, n]) => `${l} ${String(n)}`).join(", ")}`);
  for (const [l, n] of per) {
    if (n < MIN_SCOPE_ITEMS_PER_LABEL) r.errors.push(`scope: ${String(n)} items with a ${l} line, need ≥ ${String(MIN_SCOPE_ITEMS_PER_LABEL)}`);
  }
  const injection = SETS.flatMap((s) => sets[s]).filter((i) => i.injection).length;
  r.lines.push(`injection items: ${String(injection)}`);
  if (injection < MIN_INJECTION_ITEMS) r.errors.push(`${String(injection)} injection items, need ≥ ${String(MIN_INJECTION_ITEMS)}`);
}

export function checkHolds(holds: readonly GoldItem[], r: Report): void {
  const en = holds.filter((i) => i.locale === "en");
  const hi = holds.filter((i) => i.locale === "hi");
  r.lines.push(`holds: ${String(en.length)} EN / ${String(hi.length)} HI`);
  if (en.length !== HOLDS_PER_LOCALE || hi.length !== HOLDS_PER_LOCALE) r.errors.push(`holds: need ${String(HOLDS_PER_LOCALE)} EN and ${String(HOLDS_PER_LOCALE)} HI`);
  for (const item of holds) {
    if (item.hold === null) {
      r.errors.push(`${item.id}: no hold case`);
      continue;
    }
    if (holdRule(item.hold.expected_rule_id) === null) r.errors.push(`${item.id}: unknown rule ${item.hold.expected_rule_id}`);
    const twin = holds.find((t) => t.hold?.pair_id === item.hold?.pair_id && t.locale !== item.locale);
    const codes = (i: GoldItem): string => i.hypotheses.map((h) => h.fact_code ?? "").join(",");
    if (twin === undefined) r.errors.push(`${item.id}: pair ${item.hold.pair_id} has no ${item.locale === "en" ? "HI" : "EN"} item`);
    else if (codes(twin) !== codes(item)) r.errors.push(`${item.id}: fact codes differ from its pair`);
  }
}

/** AC 3 + AC 4: owner-labelled, reviewed by a non-production model, every disagreement decided. */
export function checkReviews(sets: GoldSets, rows: readonly Disagreement[], r: Report): void {
  for (const s of SETS) {
    const pairs: (readonly [Label, Label])[] = [];
    for (const item of sets[s]) {
      if (item.review === null) {
        r.errors.push(`${item.id}: no review record (run eval:label --reconcile)`);
        continue;
      }
      if (item.review.model === PROD_MODEL[s]) r.errors.push(`${item.id}: reviewed by the production model ${PROD_MODEL[s]}`);
      for (const h of item.hypotheses) {
        const model = item.review.labels.find((l) => l.h_id === h.h_id)?.label;
        if (model === undefined) {
          r.errors.push(`${item.id}/${h.h_id}: not reviewed`);
          continue;
        }
        const row = rows.find((d) => d.item_id === item.id && d.h_id === h.h_id);
        if (row === undefined && model !== h.label) r.errors.push(`${item.id}/${h.h_id}: disagreement without a decision`);
        if (row !== undefined && (row.final !== h.label || row.model_label !== model)) r.errors.push(`${item.id}/${h.h_id}: disagreements.jsonl does not match the item`);
        pairs.push([row?.owner_label ?? h.label, model]);
      }
    }
    const k = cohensKappa(pairs);
    const n = rows.filter((d) => d.set === s).length;
    r.lines.push(`kappa ${s}: ${k.kappa.toFixed(3)} (agreement ${(k.po * 100).toFixed(1)}%, n=${String(k.n)} hypotheses, ${String(n)} disagreements)`);
  }
}

export function checkSpend(byDay: ReadonlyMap<string, number>, r: Report): void {
  let total = 0;
  for (const [day, usd] of [...byDay].sort()) {
    total += usd;
    r.lines.push(`spend ${day}: $${usd.toFixed(4)}`);
    if (usd > DAILY_BUDGET_USD) r.errors.push(`spend ${day}: $${usd.toFixed(4)} over the $${DAILY_BUDGET_USD.toFixed(2)} daily budget`);
  }
  r.lines.push(`spend total: $${total.toFixed(4)}`);
}
