// `pnpm eval:label [--set <set>] [--item <id>]`  (P-53, the owner's step)
// Shows each drafted item that has no owner label yet and records the label, spans (selected by quote)
// and a note per hypothesis into gold/<set>.jsonl, saving after every item (quit any time, resume later).
// `--item <id>` re-labels one item. The generator's target label and the model's review are never shown.
//
// `pnpm eval:label --reconcile`: after `eval:review`, embeds each review and asks the owner to settle every
// disagreement (final label + reason) -> gold/disagreements.jsonl.
import { createInterface } from "node:readline/promises";
import { argValue, DISAGREEMENTS_FILE, draftFile, goldFile, readJsonl, reviewFile, writeJsonl } from "./io.ts";
import { labelItem, reconcileItem, type Prompter } from "./label-core.ts";
import { DisagreementSchema, DraftItemSchema, GoldItemSchema, ReviewSchema, SETS, type Disagreement, type GoldItem, type GoldSet } from "./schema.ts";

/** Gold items in draft order, so the file is stable however the owner moves through it. */
function save(set: GoldSet, items: ReadonlyMap<string, GoldItem>): void {
  const order = readJsonl(draftFile(set), DraftItemSchema).map((d) => d.id);
  writeJsonl(goldFile(set), order.flatMap((id) => (items.has(id) ? [items.get(id) as GoldItem] : [])));
}

async function labelSet(set: GoldSet, only: string | undefined, io: Prompter): Promise<"done" | "quit"> {
  const drafts = readJsonl(draftFile(set), DraftItemSchema);
  const done = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  const todo = drafts.filter((d) => (only === undefined ? !done.has(d.id) : d.id === only));
  io.say(`\n##### ${set}: ${String(done.size)}/${String(drafts.length)} labelled, ${String(todo.length)} to do`);
  for (const d of todo) {
    const result = await labelItem(d, io);
    if (result === "quit") return "quit";
    if (result === "skip") continue;
    done.set(d.id, result);
    save(set, done);
    io.say(`saved ${d.id} (${String(done.size)}/${String(drafts.length)})`);
  }
  return "done";
}

async function reconcileSet(set: GoldSet, rows: Disagreement[], io: Prompter): Promise<void> {
  const reviews = new Map(readJsonl(reviewFile(set), ReviewSchema).map((r) => [r.item_id, r]));
  const items = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  for (const [id, item] of items) {
    const review = reviews.get(id);
    if (review === undefined) {
      io.say(`${id}: no review yet (run pnpm eval:review)`);
      continue;
    }
    const decided = rows.filter((r) => r.item_id === id);
    const out = await reconcileItem(item, review, decided, io);
    items.set(id, out.item);
    rows.splice(0, rows.length, ...rows.filter((r) => r.item_id !== id), ...out.rows);
    save(set, items);
    writeJsonl(DISAGREEMENTS_FILE, rows);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: Prompter = { ask: (q) => rl.question(q), say: (t) => { console.log(t); } };
  const sets = SETS.filter((s) => (argValue(argv, "--set") ?? s) === s);
  try {
    if (argv.includes("--reconcile")) {
      const rows = readJsonl(DISAGREEMENTS_FILE, DisagreementSchema);
      for (const set of sets) await reconcileSet(set, rows, io);
      io.say(`\nreconciled: ${String(rows.length)} disagreement(s) in gold/disagreements.jsonl`);
      return;
    }
    for (const set of sets) if ((await labelSet(set, argValue(argv, "--item"), io)) === "quit") break;
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
