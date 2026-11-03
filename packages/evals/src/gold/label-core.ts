// The owner's labelling steps, independent of the terminal: every prompt goes through `Prompter`, so the
// flow is tested with scripted answers. Spans are selected by quote; offsets are computed (spans.ts).
import type { Disagreement, DraftItem, GoldHypothesis, GoldItem, Label, Review, Span } from "./schema.ts";
import { locateQuote } from "./spans.ts";

export interface Prompter {
  ask(question: string): Promise<string>;
  say(text: string): void;
}

const KEYS: Readonly<Record<string, Label>> = { m: "met", p: "partial", x: "missing", u: "unverifiable" };

export function parseLabel(input: string): Label | "skip" | "quit" | null {
  const k = input.trim().toLowerCase();
  if (k === "s") return "skip";
  if (k === "q") return "quit";
  return KEYS[k] ?? null;
}

export function showItem(item: DraftItem, io: Prompter): void {
  io.say(`\n=== ${item.id} · ${item.set} · ${item.locale} · ${item.persona.country} · ${item.persona.trade} (${item.persona.offering}, ${item.persona.currency})`);
  for (const d of item.documents) io.say(`\n--- ${d.doc_id} [${d.kind}] ${d.title}\n${d.text}`);
}

async function askSpan(item: DraftItem, io: Prompter): Promise<Span | null> {
  for (;;) {
    const quote = await io.ask("  quote (copy from a document; empty = done): ");
    if (quote === "") return null;
    const loc = locateQuote(item.documents, quote);
    if (loc.kind === "ok") return loc.span;
    if (loc.kind === "not_found") {
      io.say("  not found verbatim in any document; try again");
      continue;
    }
    loc.places.forEach((p, i) => { io.say(`  [${String(i + 1)}] ${p.doc_id} at ${String(p.start)}`); });
    const n = Number(await io.ask("  which one? "));
    const picked = locateQuote(item.documents, quote, null, n - 1);
    if (picked.kind === "ok") return picked.span;
    io.say("  no such choice; try again");
  }
}

async function askLabel(io: Prompter, prompt: string): Promise<Label | "skip" | "quit"> {
  for (;;) {
    const parsed = parseLabel(await io.ask(prompt));
    if (parsed !== null) return parsed;
    io.say("  m = met, p = partial, x = missing, u = unverifiable, s = skip item, q = quit");
  }
}

async function labelHypothesis(item: DraftItem, h: DraftItem["hypotheses"][number], io: Prompter): Promise<GoldHypothesis | "skip" | "quit"> {
  io.say(`\n${h.h_id}: ${h.text}${h.field ? `   [${h.field} = ${h.value ?? "—"}]` : ""}`);
  const label = await askLabel(io, "  label [m/p/x/u, s skip, q quit]: ");
  if (label === "skip" || label === "quit") return label;
  const spans: Span[] = [];
  while (label !== "unverifiable") {
    const span = await askSpan(item, io);
    if (span !== null) spans.push(span);
    else if (spans.length > 0 || label === "missing") break;
    else io.say(`  ${label} needs at least one quote`);
  }
  const note = await io.ask("  note (optional): ");
  return { ...h, label, spans, note };
}

/** Shows one draft and records the owner's label, spans and note per hypothesis. */
export async function labelItem(item: DraftItem, io: Prompter): Promise<GoldItem | "skip" | "quit"> {
  showItem(item, io);
  const hypotheses: GoldHypothesis[] = [];
  for (const h of item.hypotheses) {
    const done = await labelHypothesis(item, h, io);
    if (done === "skip" || done === "quit") return done;
    hypotheses.push(done);
  }
  return { ...item, hypotheses, labelled_by: "owner", review: null };
}

/**
 * Embeds the second model's review and settles each disagreement: the owner sees both labels and picks
 * the final one (owner's or model's) with a reason. Choosing the model's label adopts its verified spans.
 * Rows already decided (a resumed session) are reused, never asked again.
 */
export async function reconcileItem(
  item: GoldItem,
  review: Review,
  decided: readonly Disagreement[],
  io: Prompter,
): Promise<{ item: GoldItem; rows: Disagreement[] }> {
  const rows: Disagreement[] = [];
  const hypotheses: GoldHypothesis[] = [];
  for (const h of item.hypotheses) {
    const m = review.labels.find((l) => l.h_id === h.h_id);
    const prior = decided.find((d) => d.item_id === item.id && d.h_id === h.h_id);
    const owner = prior?.owner_label ?? h.label;
    if (m === undefined || m.label === owner) {
      hypotheses.push(h);
      continue;
    }
    const row = prior ?? (await decide(item, h, owner, m, review.model, io));
    rows.push(row);
    hypotheses.push(row.final === h.label ? h : { ...h, label: row.final, spans: await finalSpans(item, row.final, m.spans, io) });
  }
  return { item: { ...item, hypotheses, review }, rows };
}

/** The model's verified spans for its label; when it has none and the label needs one, the owner quotes. */
async function finalSpans(item: GoldItem, label: Label, modelSpans: readonly Span[], io: Prompter): Promise<Span[]> {
  if (label === "unverifiable") return [];
  if (modelSpans.length > 0 || label === "missing") return [...modelSpans];
  const spans: Span[] = [];
  while (spans.length === 0) {
    io.say(`  ${label} needs at least one quote (the model's quotes were not verbatim)`);
    const s = await askSpan(item, io);
    if (s !== null) spans.push(s);
  }
  return spans;
}

async function decide(
  item: GoldItem,
  h: GoldHypothesis,
  owner: Label,
  m: Review["labels"][number],
  model: string,
  io: Prompter,
): Promise<Disagreement> {
  io.say(`\n${item.id}/${h.h_id}: ${h.text}\n  owner: ${owner}\n  model (${model}): ${m.label} ${m.spans.map((s) => `"${s.quote}"`).join(" | ")}`);
  let final: Label | null = null;
  while (final === null) {
    const a = (await io.ask("  final [o = owner's, r = model's]: ")).trim().toLowerCase();
    final = a === "o" ? owner : a === "r" ? m.label : null;
  }
  let reason = "";
  while (reason === "") reason = (await io.ask("  reason: ")).trim();
  return { set: item.set, item_id: item.id, h_id: h.h_id, owner_label: owner, model_label: m.label, model, final, reason };
}
