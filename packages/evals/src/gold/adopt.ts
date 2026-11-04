// `pnpm eval:adopt-dev`: writes the `dev` items into gold/<set>.jsonl from the second-model reviews.
// Owner decisions 2026-11-03/04 (#45): `test` items get a primary label (`claude:<id>` or `owner`);
// `dev` items (prompt work, never reported) take the review's labels and spans verbatim, marked
// `labelled_by: "model:<reviewer id>"`.
// A `dev` item whose review cannot stand as a label (e.g. `met` with no verbatim span) is refused: nothing
// is written for it, no rule is relaxed, and it joins the `eval:label` queue instead.
// Deterministic: no API call, no spend; re-running it rewrites the same bytes. Items with a primary label
// (`owner` or `claude:<id>`) already in the file are kept as they are.
import { draftFile, goldFile, readJsonl, reviewFile, writeJsonl } from "./io.ts";
import { DraftItemSchema, GoldItemSchema, isPrimaryLabel, modelLabel, PROD_MODEL, ReviewSchema, SETS, type DraftItem, type GoldItem, type GoldSet, type Review } from "./schema.ts";
import { spanProblem } from "./spans.ts";

/** Why `review` cannot stand as the label of the dev item `draft`, or null when it can. */
export function adoptionProblem(draft: DraftItem, review: Review | undefined): string | null {
  if (draft.split !== "dev") return `${draft.id}: only dev items take the review's labels`;
  if (review === undefined) return `${draft.id}: no review (run pnpm eval:review)`;
  if (review.item_id !== draft.id) return `${draft.id}: review is for ${review.item_id}`;
  if (review.model === PROD_MODEL[draft.set]) return `${draft.id}: reviewed by the production model ${review.model}`;
  for (const h of draft.hypotheses) {
    const m = review.labels.find((l) => l.h_id === h.h_id);
    if (m === undefined) return `${draft.id}/${h.h_id}: not reviewed`;
    const bad = m.spans.map((s) => spanProblem(draft.documents, s)).find((p) => p !== null);
    if (bad !== undefined) return `${draft.id}/${h.h_id}: ${bad}`;
    if ((m.label === "met" || m.label === "partial") && m.spans.length === 0) {
      return `${draft.id}/${h.h_id}: the reviewer's ${m.label} has no verbatim span (${String(m.unmatched_quotes)} quote(s) not verbatim)`;
    }
    if (m.label === "unverifiable" && m.spans.length > 0) return `${draft.id}/${h.h_id}: the reviewer's unverifiable has spans`;
  }
  return null;
}

/** What `eval:label` labels (owner or Claude): every `test` item, plus each `dev` item adoption refuses. */
export function labelQueue(drafts: readonly DraftItem[], reviews: readonly Review[]): DraftItem[] {
  return drafts.filter((d) => d.split === "test" || adoptionProblem(d, reviews.find((r) => r.item_id === d.id)) !== null);
}

/** One `dev` draft labelled from its review, verbatim. Throws when `adoptionProblem` finds one. */
export function adoptDevItem(draft: DraftItem, review: Review): GoldItem {
  const problem = adoptionProblem(draft, review);
  if (problem !== null) throw new Error(problem);
  const hypotheses = draft.hypotheses.map((h) => {
    const m = review.labels.find((l) => l.h_id === h.h_id);
    if (m === undefined) throw new Error(`${draft.id}/${h.h_id}: not reviewed`);
    return { ...h, label: m.label, spans: [...m.spans], note: "" };
  });
  return { ...draft, hypotheses, labelled_by: modelLabel(review.model), review };
}

/**
 * The set's gold items in draft order. A `dev` draft is adopted from its review unless it already has a
 * primary label (owner or Claude); a refused one is left out and listed in `refused`. Every other item stays.
 */
export function adoptDevSet(
  drafts: readonly DraftItem[],
  reviews: readonly Review[],
  existing: readonly GoldItem[],
): { items: GoldItem[]; refused: string[] } {
  const byId = new Map(existing.map((g) => [g.id, g]));
  const refused: string[] = [];
  const items = drafts.flatMap((d) => {
    const have = byId.get(d.id);
    if (d.split !== "dev" || (have !== undefined && isPrimaryLabel(have.labelled_by))) return have === undefined ? [] : [have];
    const review = reviews.find((r) => r.item_id === d.id);
    const problem = adoptionProblem(d, review);
    if (problem !== null || review === undefined) {
      refused.push(problem ?? `${d.id}: no review`);
      return [];
    }
    return [adoptDevItem(d, review)];
  });
  return { items, refused };
}

function adoptSet(set: GoldSet): string[] {
  const drafts = readJsonl(draftFile(set), DraftItemSchema);
  const { items, refused } = adoptDevSet(drafts, readJsonl(reviewFile(set), ReviewSchema), readJsonl(goldFile(set), GoldItemSchema));
  writeJsonl(goldFile(set), items);
  const dev = drafts.filter((d) => d.split === "dev").length;
  const adopted = items.filter((i) => i.split === "dev" && !isPrimaryLabel(i.labelled_by)).length;
  console.log(`${set}: ${String(adopted)}/${String(dev)} dev items adopted from the review, ${String(refused.length)} refused (eval:label labels them)`);
  return refused;
}

if (import.meta.main) {
  for (const p of SETS.flatMap(adoptSet)) console.log(`REFUSED ${p}`);
}
