// `pnpm eval:label [--split test] [--set <set>] [--item <id>] [--by owner|claude:<id>] [--from <answers.jsonl>]`
// Owner decisions 2026-11-03 and 2026-11-04 (#45): the `test` split (the default and only `--split`) gets a
// primary label, from Claude (`--by claude:<model id>`) or the owner (`owner`, the default), plus any `dev`
// item `eval:adopt-dev` refused (its review cannot stand as a label). Other `dev` items take the review's
// labels (`eval:adopt-dev`) and are never offered here.
// Shows each queued item that has no primary label yet and records the label, spans (selected by quote)
// and a note per hypothesis into gold/<set>.jsonl, saving after every item (quit any time, resume later).
// `--item <id>` re-labels one queued item. The generator's target label and the model's review are never shown.
// `--from <file>` reads written answers instead of the terminal (one `LabelAnswerSchema` line per item;
// each quote names its document and is placed at its first occurrence there), through the same checks.
//
// `pnpm eval:label --reconcile [--by …] [--from <decisions.jsonl>]`: after `eval:review`, embeds each review
// in the primary-labelled items and settles every disagreement on `test` items (final label + reason,
// `decided_by`) -> gold/disagreements.jsonl. A primary-labelled `dev` item only gets its review embedded.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { labelQueue } from "./adopt.ts";
import { argValue, DISAGREEMENTS_FILE, draftFile, goldFile, readJsonl, reviewFile, writeJsonl } from "./io.ts";
import {
  applyAnswer,
  askDecider,
  DecisionAnswerSchema,
  fileDecider,
  LabelAnswerSchema,
  labelItem,
  reconcileItem,
  type Decider,
  type LabelAnswer,
  type Prompter,
} from "./label-core.ts";
import {
  DecidedBySchema,
  DisagreementSchema,
  DraftItemSchema,
  GoldItemSchema,
  isPrimaryLabel,
  ReviewSchema,
  SETS,
  type DecidedBy,
  type Disagreement,
  type DraftItem,
  type GoldItem,
  type GoldSet,
} from "./schema.ts";

/** Gold items in draft order, so the file is stable however the labeller moves through it. */
function save(set: GoldSet, items: ReadonlyMap<string, GoldItem>): void {
  const order = readJsonl(draftFile(set), DraftItemSchema).map((d) => d.id);
  writeJsonl(goldFile(set), order.flatMap((id) => (items.has(id) ? [items.get(id) as GoldItem] : [])));
}

/** Labels one item: from the written answers when given, else in the terminal. */
type Labeller = (d: DraftItem) => Promise<GoldItem | "skip" | "quit">;

function answersLabeller(answers: readonly LabelAnswer[], by: DecidedBy): Labeller {
  return (d) => {
    const a = answers.find((x) => x.id === d.id);
    return Promise.resolve(a === undefined ? "skip" : applyAnswer(d, a, by));
  };
}

async function labelSet(set: GoldSet, only: string | undefined, label: Labeller, io: Prompter): Promise<"done" | "quit"> {
  const queue = labelQueue(readJsonl(draftFile(set), DraftItemSchema), readJsonl(reviewFile(set), ReviewSchema));
  const all = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  const labelled = (id: string): boolean => {
    const by = all.get(id)?.labelled_by;
    return by !== undefined && isPrimaryLabel(by);
  };
  const todo = queue.filter((d) => (only === undefined ? !labelled(d.id) : d.id === only));
  const count = (): string => `${String(queue.filter((d) => labelled(d.id)).length)}/${String(queue.length)}`;
  io.say(`\n##### ${set}: ${count()} labelled (test split + refused dev), ${String(todo.length)} to do`);
  for (const d of todo) {
    const result = await label(d);
    if (result === "quit") return "quit";
    if (result === "skip") continue;
    all.set(d.id, result);
    save(set, all);
    io.say(`saved ${d.id} (${count()})`);
  }
  return "done";
}

async function reconcileSet(set: GoldSet, rows: Disagreement[], decide: Decider, by: DecidedBy, io: Prompter): Promise<void> {
  const reviews = new Map(readJsonl(reviewFile(set), ReviewSchema).map((r) => [r.item_id, r]));
  const items = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  for (const [id, item] of items) {
    if (!isPrimaryLabel(item.labelled_by)) continue;
    const review = reviews.get(id);
    if (review === undefined) {
      io.say(`${id}: no review yet (run pnpm eval:review)`);
      continue;
    }
    if (item.split === "dev") {
      items.set(id, { ...item, review });
    } else {
      const out = await reconcileItem(item, review, rows.filter((r) => r.item_id === id), decide, by);
      items.set(id, out.item);
      rows.splice(0, rows.length, ...rows.filter((r) => r.item_id !== id), ...out.rows);
    }
    save(set, items);
    writeJsonl(DISAGREEMENTS_FILE, rows);
  }
}

/** One JSON object per line from a written-answers file. */
function readLines(file: string): unknown[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as unknown);
}

async function main(argv: readonly string[]): Promise<void> {
  const split = argValue(argv, "--split") ?? "test";
  if (split !== "test") throw new Error(`--split ${split}: only the test split is labelled here; dev items come from the review (pnpm eval:adopt-dev)`);
  const by = DecidedBySchema.parse(argValue(argv, "--by") ?? "owner");
  const from = argValue(argv, "--from");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: Prompter = { ask: (q) => rl.question(q), say: (t) => { console.log(t); } };
  const sets = SETS.filter((s) => (argValue(argv, "--set") ?? s) === s);
  try {
    if (argv.includes("--reconcile")) {
      const rows = readJsonl(DISAGREEMENTS_FILE, DisagreementSchema);
      const decide = from === undefined ? askDecider(io) : fileDecider(readLines(from).map((l) => DecisionAnswerSchema.parse(l)));
      for (const set of sets) await reconcileSet(set, rows, decide, by, io);
      io.say(`\nreconciled: ${String(rows.length)} disagreement(s) in gold/disagreements.jsonl`);
      return;
    }
    const label: Labeller = from === undefined ? (d) => labelItem(d, io, by) : answersLabeller(readLines(from).map((l) => LabelAnswerSchema.parse(l)), by);
    for (const set of sets) if ((await labelSet(set, argValue(argv, "--item"), label, io)) === "quit") break;
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
