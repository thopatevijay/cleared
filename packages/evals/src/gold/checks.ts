// The gold-set checks behind `pnpm eval:validate` (pure: data in, report out). Each check appends to
// `errors`; `lines` is what the command prints (counts, per-label coverage, kappa, spend).
import { holdRule } from "@cleared/core";
import { cohensKappa } from "./kappa.ts";
import { DEV_SHARE, splitFor } from "./plan.ts";
import { LABELS, modelLabel, PROD_MODEL, SET_SIZE, SETS, type Disagreement, type GoldItem, type GoldSet, type Label, type Review } from "./schema.ts";
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

/**
 * AC 3 (amended 2026-11-03): who labelled the item. A `test` item is `owner`; a `dev` item is `owner` or
 * `model:<its reviewer>` (a non-production model), and a model-labelled one carries the review verbatim.
 */
function checkLabelledBy(item: GoldItem, review: Review, r: Report): void {
  if (item.split === "test" && item.labelled_by !== "owner") r.errors.push(`${item.id}: test item labelled_by ${item.labelled_by}, must be owner`);
  if (item.labelled_by === "owner") return;
  if (item.labelled_by !== modelLabel(review.model)) r.errors.push(`${item.id}: labelled_by ${item.labelled_by} is not its reviewer ${modelLabel(review.model)}`);
  for (const h of item.hypotheses) {
    const m = review.labels.find((l) => l.h_id === h.h_id);
    if (m !== undefined && (m.label !== h.label || JSON.stringify(m.spans) !== JSON.stringify(h.spans))) {
      r.errors.push(`${item.id}/${h.h_id}: model-labelled, but the label or spans differ from the review`);
    }
  }
}

/** AC 4 (amended): every owner/reviewer disagreement on a `test` item has a decision; kappa over `test` only. */
function testPairs(item: GoldItem, review: Review, rows: readonly Disagreement[], r: Report): (readonly [Label, Label])[] {
  const pairs: (readonly [Label, Label])[] = [];
  for (const h of item.hypotheses) {
    const model = review.labels.find((l) => l.h_id === h.h_id)?.label;
    const row = rows.find((d) => d.item_id === item.id && d.h_id === h.h_id);
    if (model === undefined) {
      r.errors.push(`${item.id}/${h.h_id}: not reviewed`);
      continue;
    }
    if (item.split === "dev") {
      if (row !== undefined) r.errors.push(`${item.id}/${h.h_id}: disagreements.jsonl row on a dev item (test only)`);
      continue;
    }
    if (row === undefined && model !== h.label) r.errors.push(`${item.id}/${h.h_id}: disagreement without a decision`);
    if (row !== undefined && (row.final !== h.label || row.model_label !== model)) r.errors.push(`${item.id}/${h.h_id}: disagreements.jsonl does not match the item`);
    pairs.push([row?.owner_label ?? h.label, model]);
  }
  return pairs;
}

/** AC 3 + AC 4: who labelled each item, a review by a non-production model, test disagreements decided, kappa. */
export function checkReviews(sets: GoldSets, rows: readonly Disagreement[], r: Report): void {
  for (const s of SETS) {
    const pairs: (readonly [Label, Label])[] = [];
    for (const item of sets[s]) {
      if (item.review === null) {
        r.errors.push(`${item.id}: no review record (run eval:label --reconcile)`);
        continue;
      }
      if (item.review.model === PROD_MODEL[s]) r.errors.push(`${item.id}: reviewed by the production model ${PROD_MODEL[s]}`);
      checkLabelledBy(item, item.review, r);
      pairs.push(...testPairs(item, item.review, rows, r));
    }
    const k = cohensKappa(pairs);
    const testIds = new Set(sets[s].filter((i) => i.split === "test").map((i) => i.id));
    const n = rows.filter((d) => d.set === s && testIds.has(d.item_id)).length;
    r.lines.push(`kappa ${s} (test only): ${k.kappa.toFixed(3)} (agreement ${(k.po * 100).toFixed(1)}%, n=${String(k.n)} hypotheses, ${String(n)} disagreements)`);
  }
}

/** Owner labels still to come: queued items (test + refused dev) without `labelled_by: "owner"`. */
export function checkOwnerLabels(sets: GoldSets, queue: Readonly<Record<GoldSet, readonly string[]>>, r: Report): void {
  const missing = SETS.flatMap((s) => queue[s].filter((id) => sets[s].find((i) => i.id === id)?.labelled_by !== "owner"));
  const total = SETS.reduce((n, s) => n + queue[s].length, 0);
  r.lines.push(`owner-labelled: ${String(total - missing.length)}/${String(total)} (test split + dev items the review could not label)`);
  if (missing.length > 0) {
    r.errors.push(`owner labels missing (P-53): ${String(missing.length)}/${String(total)} items: run \`pnpm eval:label\`, then \`pnpm eval:label --reconcile\``);
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
