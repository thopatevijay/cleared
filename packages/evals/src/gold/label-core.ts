// The labelling steps (owner or Claude), independent of the terminal: every prompt goes through
// `Prompter`, so the flow is tested with scripted answers; written answers (`--from`) pass the same
// checks. Spans are selected by quote; offsets are computed (spans.ts).
import { z } from "zod";
import { LabelSchema, type DecidedBy, type Disagreement, type DraftItem, type GoldHypothesis, type GoldItem, type Label, type Review, type Span } from "./schema.ts";
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

/** Shows one draft and records the labeller's label, spans and note per hypothesis. */
export async function labelItem(item: DraftItem, io: Prompter, by: DecidedBy = "owner"): Promise<GoldItem | "skip" | "quit"> {
  showItem(item, io);
  const hypotheses: GoldHypothesis[] = [];
  for (const h of item.hypotheses) {
    const done = await labelHypothesis(item, h, io);
    if (done === "skip" || done === "quit") return done;
    hypotheses.push(done);
  }
  return { ...item, hypotheses, labelled_by: by, review: null };
}

/** A label written ahead of time (`eval:label --from`): quotes name their document; offsets are computed. */
export const QuoteSchema = z.object({ doc_id: z.string().min(1), quote: z.string().min(1) });
export const LabelAnswerSchema = z.object({
  id: z.string(),
  hypotheses: z.array(z.object({ h_id: z.string(), label: LabelSchema, quotes: z.array(QuoteSchema), note: z.string() })),
});
export type LabelAnswer = z.infer<typeof LabelAnswerSchema>;

/** Spans for quotes, each at its first occurrence in the named document. Throws when one is not verbatim. */
export function spansFor(item: DraftItem, quotes: readonly z.infer<typeof QuoteSchema>[], where: string): Span[] {
  return quotes.map((q) => {
    const loc = locateQuote(item.documents, q.quote, q.doc_id, 0);
    if (loc.kind !== "ok") throw new Error(`${where}: quote not verbatim in ${q.doc_id}: ${JSON.stringify(q.quote)}`);
    return loc.span;
  });
}

/** The same rules the terminal flow enforces: met/partial need a quote, unverifiable has none. */
function spanRule(label: Label, spans: readonly Span[], where: string): void {
  if ((label === "met" || label === "partial") && spans.length === 0) throw new Error(`${where}: ${label} needs at least one quote`);
  if (label === "unverifiable" && spans.length > 0) throw new Error(`${where}: unverifiable has no quotes`);
}

/** Labels one draft from a written answer (same output shape as `labelItem`). Throws on any mismatch. */
export function applyAnswer(item: DraftItem, answer: LabelAnswer, by: DecidedBy): GoldItem {
  if (answer.id !== item.id) throw new Error(`answer ${answer.id} is not for ${item.id}`);
  const ids = (xs: readonly { h_id: string }[]): string => xs.map((x) => x.h_id).join(",");
  if (ids(answer.hypotheses) !== ids(item.hypotheses)) throw new Error(`${item.id}: answers ${ids(answer.hypotheses)}, expected ${ids(item.hypotheses)}`);
  const hypotheses = item.hypotheses.map((h, k) => {
    const a = answer.hypotheses[k];
    if (a === undefined) throw new Error(`${item.id}/${h.h_id}: no answer`);
    const where = `${item.id}/${h.h_id}`;
    const spans = spansFor(item, a.quotes, where);
    spanRule(a.label, spans, where);
    return { ...h, label: a.label, spans, note: a.note };
  });
  return { ...item, hypotheses, labelled_by: by, review: null };
}

/**
 * One settled disagreement: the final label (the labeller's or the reviewer's), a reason and, when the
 * final label is the reviewer's and needs other spans than the reviewer's, the spans to keep.
 */
export interface Decision {
  readonly final: Label;
  readonly reason: string;
  readonly spans?: readonly Span[];
}

type ReviewLabel = Review["labels"][number];

/** Settles one disagreement on hypothesis `h`: `first` is the labeller's label, `m` the reviewer's. */
export type Decider = (item: GoldItem, h: GoldHypothesis, first: Label, m: ReviewLabel, model: string) => Promise<Decision>;

/**
 * Embeds the second model's review and settles each disagreement through `decide` (the terminal or a
 * written decisions file): the final label is the labeller's or the model's, with a reason, recorded as
 * decided by `by`. Choosing the model's label adopts its verified spans unless the decision gives its own.
 * Rows already decided (a resumed session) are reused, never asked again.
 */
export async function reconcileItem(
  item: GoldItem,
  review: Review,
  decided: readonly Disagreement[],
  decide: Decider,
  by: DecidedBy,
): Promise<{ item: GoldItem; rows: Disagreement[] }> {
  const rows: Disagreement[] = [];
  const hypotheses: GoldHypothesis[] = [];
  for (const h of item.hypotheses) {
    const m = review.labels.find((l) => l.h_id === h.h_id);
    const prior = decided.find((d) => d.item_id === item.id && d.h_id === h.h_id);
    const first = prior?.labeller_label ?? h.label;
    if (m === undefined || m.label === first || prior !== undefined) {
      if (prior !== undefined && m !== undefined && m.label !== first) rows.push(prior);
      hypotheses.push(h);
      continue;
    }
    const d = await decide(item, h, first, m, review.model);
    if (d.final !== first && d.final !== m.label) throw new Error(`${item.id}/${h.h_id}: final ${d.final} is neither ${first} nor ${m.label}`);
    rows.push({ set: item.set, item_id: item.id, h_id: h.h_id, labeller_label: first, model_label: m.label, model: review.model, final: d.final, reason: d.reason, decided_by: by });
    if (d.final === h.label) {
      hypotheses.push(h);
      continue;
    }
    const note = `${h.note === "" ? "" : `${h.note} `}Reconciled to ${d.final}: ${d.reason}`;
    hypotheses.push({ ...h, label: d.final, spans: finalSpans(`${item.id}/${h.h_id}`, d, m.spans), note });
  }
  return { item: { ...item, hypotheses, review }, rows };
}

/** The spans kept for a flipped label: the decision's own, else the model's verified ones (checked). */
function finalSpans(where: string, d: Decision, modelSpans: readonly Span[]): Span[] {
  const spans = d.final === "unverifiable" ? [] : [...(d.spans ?? modelSpans)];
  spanRule(d.final, spans, where);
  return spans;
}

/** The terminal decider: shows both labels; when the model's label has no verbatim span, asks for a quote. */
export function askDecider(io: Prompter): Decider {
  return async (item, h, first, m, model) => {
    io.say(`\n${item.id}/${h.h_id}: ${h.text}\n  labeller: ${first}\n  model (${model}): ${m.label} ${m.spans.map((s) => `"${s.quote}"`).join(" | ")}`);
    let final: Label | null = null;
    while (final === null) {
      const a = (await io.ask("  final [o = labeller's, r = model's]: ")).trim().toLowerCase();
      final = a === "o" ? first : a === "r" ? m.label : null;
    }
    let reason = "";
    while (reason === "") reason = (await io.ask("  reason: ")).trim();
    if (final === first || (final !== "met" && final !== "partial") || m.spans.length > 0) return { final, reason };
    const spans: Span[] = [];
    while (spans.length === 0) {
      io.say(`  ${final} needs at least one quote (the model's quotes were not verbatim)`);
      const s = await askSpan(item, io);
      if (s !== null) spans.push(s);
    }
    return { final, reason, spans };
  };
}

/** A decision written ahead of time (`eval:label --reconcile --from`), one per disagreement. */
export const DecisionAnswerSchema = z.object({
  id: z.string(),
  h_id: z.string(),
  final: LabelSchema,
  reason: z.string().min(1),
  quotes: z.array(QuoteSchema).optional(),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

/** The written-decisions decider. Rejects when a disagreement has no written decision. */
export function fileDecider(answers: readonly DecisionAnswer[]): Decider {
  return (item, h) => {
    const a = answers.find((x) => x.id === item.id && x.h_id === h.h_id);
    if (a === undefined) return Promise.reject(new Error(`${item.id}/${h.h_id}: no written decision`));
    if (a.quotes === undefined) return Promise.resolve({ final: a.final, reason: a.reason });
    return Promise.resolve({ final: a.final, reason: a.reason, spans: spansFor(item, a.quotes, `${item.id}/${h.h_id}`) });
  };
}
