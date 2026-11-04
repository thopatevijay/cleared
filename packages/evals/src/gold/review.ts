// `pnpm eval:review [--replay] [--set <set>] [--only <id,…>] [--max-usd <n>]`
// The second model labels every drafted item independently of the owner (it never sees the owner's
// labels or the generator's targets). Its model differs from the production model for that task
// (schema.ts REVIEW_MODEL vs PROD_MODEL). Answers are recorded under fixtures/openai/gold/review/ and
// written to gold/reviews/<set>.jsonl; `eval:label --reconcile` embeds them in the labelled items.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createLiveCaller, createReplayCaller, GOLD_FIXTURE_DIR, type Caller, type CallSpec } from "./ai.ts";
import { argValue, draftFile, readJsonl, reviewFile, writeJsonl } from "./io.ts";
import { HYPOTHESIS_KIND, REVIEW_INSTRUCTIONS, REVIEW_PROMPT_VERSION } from "./prompts.ts";
import { DraftItemSchema, LabelSchema, PROD_MODEL, REVIEW_MODEL, SETS, type DraftItem, type GoldSet, type Review } from "./schema.ts";
import { locateQuote } from "./spans.ts";
import { createSpendLedger } from "./spend.ts";

export const ReviewOutputSchema = z.object({
  labels: z.array(
    z.object({
      h_id: z.string(),
      label: LabelSchema,
      citations: z.array(z.object({ doc_id: z.string(), quote: z.string().min(1).max(600) })).max(6),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export function reviewTask(item: DraftItem): string {
  const hyps = item.hypotheses.map((h) => ({
    h_id: h.h_id,
    text: h.text,
    ...(h.field ? { field: h.field, expected_value: h.value } : {}),
  }));
  return `Hypotheses (${HYPOTHESIS_KIND[item.set]}):\n${JSON.stringify(hyps, null, 2)}\nThe documents follow as evidence blocks; their evidence id is the doc_id.`;
}

export function reviewSpec(item: DraftItem): CallSpec<typeof ReviewOutputSchema> {
  const model = REVIEW_MODEL[item.set];
  if (model === PROD_MODEL[item.set]) throw new Error(`review: ${item.set} reviewer equals the production model`);
  return {
    name: `review/${item.id}`,
    model,
    schemaName: "gold_review",
    schema: ReviewOutputSchema,
    instructions: REVIEW_INSTRUCTIONS,
    task: reviewTask(item),
    evidence: item.documents.map((d) => ({ kind: "text", evidenceId: d.doc_id, label: `${d.kind}: ${d.title}`, text: d.text })),
    maxOutputTokens: 3_000,
    reasoningEffort: "none",
  };
}

/** The model's answer -> a Review: one label per hypothesis, quotes turned into verified spans. */
export function toReview(item: DraftItem, out: ReviewOutput, model: string): Review {
  const labels = item.hypotheses.map((h) => {
    const got = out.labels.find((l) => l.h_id === h.h_id);
    if (got === undefined) throw new Error(`review ${item.id}: no label for ${h.h_id}`);
    let unmatched = 0;
    const spans = got.label === "unverifiable" ? [] : got.citations.flatMap((c) => {
      const loc = locateQuote(item.documents, c.quote, c.doc_id, 0);
      if (loc.kind === "ok") return [loc.span];
      unmatched += 1;
      return [];
    });
    return { h_id: h.h_id, label: got.label, spans, unmatched_quotes: unmatched };
  });
  return { item_id: item.id, model, prompt_version: REVIEW_PROMPT_VERSION, labels };
}

async function reviewSet(
  set: GoldSet,
  pick: (name: string) => Caller,
  width: number,
  only: ReadonlySet<string>,
): Promise<Review[]> {
  const items = readJsonl(draftFile(set), DraftItemSchema).filter((i) => only.size === 0 || only.has(i.id));
  const out: Review[] = new Array<Review>(items.length);
  const errors: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      const item = items[i] as DraftItem;
      const spec = reviewSpec(item);
      try {
        const res = await pick(spec.name).call(spec);
        out[i] = toReview(item, res.value, res.model);
      } catch (err) {
        errors.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (errors.length > 0) throw new Error(`review ${set} failed for ${String(errors.length)} item(s):\n${errors.join("\n")}`);
  return out;
}

async function main(argv: readonly string[]): Promise<void> {
  const replay = argv.includes("--replay");
  const only = new Set((argValue(argv, "--only") ?? "").split(",").filter(Boolean));
  const sets = SETS.filter((s) => (argValue(argv, "--set") ?? s) === s);
  const ledger = createSpendLedger();
  const replayer = createReplayCaller();
  let pick: (name: string) => Caller = () => replayer;
  let width = 1;
  if (!replay) {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if (apiKey === "") throw new Error("eval:review: OPENAI_API_KEY is not set (use --replay for no spend)");
    const maxUsd = Number(argValue(argv, "--max-usd") ?? process.env.EVAL_MAX_USD ?? "0.25");
    const live = createLiveCaller({ apiKey, maxUsd, onSpend: (r) => { ledger.add(r.model, r.usage, r.costUsd); } });
    const recorded = (name: string): boolean => existsSync(join(GOLD_FIXTURE_DIR, `${name}.json`));
    pick = (name) => (recorded(name) && !only.has(name.replace("review/", "")) ? replayer : live);
    width = 6;
  }
  try {
    for (const set of sets) {
      const reviews = await reviewSet(set, pick, width, only);
      if (only.size > 0) {
        console.log(`eval:review: re-recorded ${String(reviews.length)} ${set} item(s); reviews not written (run without --only)`);
        continue;
      }
      writeJsonl(reviewFile(set), reviews);
      console.log(`eval:review: ${set}: ${String(reviews.length)} reviews (${REVIEW_MODEL[set]})`);
    }
  } finally {
    ledger.flush(replay ? "eval:review --replay" : "eval:review");
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
