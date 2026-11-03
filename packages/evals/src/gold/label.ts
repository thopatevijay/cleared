// `pnpm eval:label [--split test] [--set <set>] [--item <id>]`  (P-53, the owner's step)
// Owner decision 2026-11-03 (#45): the owner labels the `test` split (the default and only `--split`),
// plus any `dev` item `eval:adopt-dev` refused (its review cannot stand as a label). Other `dev` items take
// the review's labels (`eval:adopt-dev`) and are never offered here.
// Shows each queued item that has no owner label yet and records the label, spans (selected by quote)
// and a note per hypothesis into gold/<set>.jsonl, saving after every item (quit any time, resume later).
// `--item <id>` re-labels one queued item. The generator's target label and the model's review are never shown.
//
// `pnpm eval:label --reconcile`: after `eval:review`, embeds each review in the owner-labelled items and asks
// the owner to settle every disagreement on `test` items (final label + reason) -> gold/disagreements.jsonl.
// An owner-labelled `dev` item only gets its review embedded (disagreements and kappa are test-only).
import { createInterface } from "node:readline/promises";
import { ownerQueue } from "./adopt.ts";
import { argValue, DISAGREEMENTS_FILE, draftFile, goldFile, readJsonl, reviewFile, writeJsonl } from "./io.ts";
import { labelItem, reconcileItem, type Prompter } from "./label-core.ts";
import { DisagreementSchema, DraftItemSchema, GoldItemSchema, ReviewSchema, SETS, type Disagreement, type GoldItem, type GoldSet } from "./schema.ts";

/** Gold items in draft order, so the file is stable however the owner moves through it. */
function save(set: GoldSet, items: ReadonlyMap<string, GoldItem>): void {
  const order = readJsonl(draftFile(set), DraftItemSchema).map((d) => d.id);
  writeJsonl(goldFile(set), order.flatMap((id) => (items.has(id) ? [items.get(id) as GoldItem] : [])));
}

async function labelSet(set: GoldSet, only: string | undefined, io: Prompter): Promise<"done" | "quit"> {
  const queue = ownerQueue(readJsonl(draftFile(set), DraftItemSchema), readJsonl(reviewFile(set), ReviewSchema));
  const all = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  const owned = (id: string): boolean => all.get(id)?.labelled_by === "owner";
  const todo = queue.filter((d) => (only === undefined ? !owned(d.id) : d.id === only));
  const count = (): string => `${String(queue.filter((d) => owned(d.id)).length)}/${String(queue.length)}`;
  io.say(`\n##### ${set}: ${count()} owner-labelled (test split + refused dev), ${String(todo.length)} to do`);
  for (const d of todo) {
    const result = await labelItem(d, io);
    if (result === "quit") return "quit";
    if (result === "skip") continue;
    all.set(d.id, result);
    save(set, all);
    io.say(`saved ${d.id} (${count()})`);
  }
  return "done";
}

async function reconcileSet(set: GoldSet, rows: Disagreement[], io: Prompter): Promise<void> {
  const reviews = new Map(readJsonl(reviewFile(set), ReviewSchema).map((r) => [r.item_id, r]));
  const items = new Map(readJsonl(goldFile(set), GoldItemSchema).map((g) => [g.id, g]));
  for (const [id, item] of items) {
    if (item.labelled_by !== "owner") continue;
    const review = reviews.get(id);
    if (review === undefined) {
      io.say(`${id}: no review yet (run pnpm eval:review)`);
      continue;
    }
    if (item.split === "dev") {
      items.set(id, { ...item, review });
    } else {
      const out = await reconcileItem(item, review, rows.filter((r) => r.item_id === id), io);
      items.set(id, out.item);
      rows.splice(0, rows.length, ...rows.filter((r) => r.item_id !== id), ...out.rows);
    }
    save(set, items);
    writeJsonl(DISAGREEMENTS_FILE, rows);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const split = argValue(argv, "--split") ?? "test";
  if (split !== "test") throw new Error(`--split ${split}: the owner labels the test split only; dev items come from the review (pnpm eval:adopt-dev)`);
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
