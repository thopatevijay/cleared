// The `draft_dispute@v1` workflow (M2-07, pillar P3): a dispute + a checked proof pack → the notes PayPal
// reads, the pack items to attach, and the refs each paragraph relies on. LARGE model, one call (+1 repair).
// What the model sees: PayPal's dispute fields, the pack index (kind and date per item), the extracted facts
// (without their source quotes) and M2-04's scope lines with only the citations that passed the verbatim
// check. Raw evidence text never reaches this step.
// The guarantees are ours, in code (`draftProblems`): notes ≤ 2000 code points, selected items ⊆ the pack,
// every ref resolves, and no URL / email / phone number that the pack does not contain. A failing answer
// gets one repair, then the run fails (`failed_output`): nothing is truncated or stored silently.
import type { WorkflowDef } from "../agent/harness.ts";
import type { EvidenceInput } from "../agent/guardrails.ts";
import { definePrompt, PROMPTS } from "../agent/prompts.ts";
import type { Facts } from "../proof/facts-schema.ts";
import {
  DRAFT_SCHEMA_VERSION,
  DraftOutputSchema,
  ITEM_REF,
  NOTES_MAX_CODE_POINTS,
  type DraftFact,
  type DraftInput,
  type DraftItem,
  type DraftLine,
  type DraftOutput,
  type DraftQuote,
} from "./draft-schema.ts";
import {
  DRAFT_DISPUTE_V1_ID,
  DRAFT_DISPUTE_V1_SYSTEM,
  draftDisputeV1Task,
} from "./prompts/draft-dispute.v1.ts";
import type { ReasonMapping } from "./reason-map.ts";

export const DRAFT_DISPUTE_PROMPT = PROMPTS.register(
  definePrompt(DRAFT_DISPUTE_V1_ID, DRAFT_DISPUTE_V1_SYSTEM),
);
export const DRAFT_MAX_OUTPUT_TOKENS = 3_000;

/** Validator problem codes; the job maps a failed run to the first code in its reason. */
export const DRAFT_PROBLEMS = [
  "notes_too_long",
  "unknown_evidence_id",
  "unresolved_fact_ref",
  "foreign_contact",
] as const;
export type DraftProblem = (typeof DRAFT_PROBLEMS)[number];

// ---- contacts (URL, email, phone) -----------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const DOMAIN_RE =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|in|dev|app|me|info|biz|shop|store|test|uk|us)\b(?:\/[^\s<>"'()]*)?/gi;
const PHONE_RE = /(?<![\w-])\+?\(?\d[\d\s().-]{6,}\d(?![\w-])/g;
const DATE_LIKE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;

/** `https://www.x.com/a.` → `x.com/a`: one form per link, whatever the scheme or `www.` prefix. */
const trimUrl = (s: string): string =>
  s
    .replace(/[.,;:!?]+$/, "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");

/** Every URL, email address and phone number in `text`, normalised (lower case; phones as `tel:<digits>`). */
export function contactsIn(text: string): string[] {
  const out = new Set<string>();
  const emails = text.match(EMAIL_RE) ?? [];
  for (const e of emails) out.add(`mailto:${e.toLowerCase()}`);
  const withoutEmails = emails.reduce((t, e) => t.replace(e, " "), text);
  for (const u of withoutEmails.match(URL_RE) ?? []) out.add(`url:${trimUrl(u)}`);
  const withoutUrls = withoutEmails.replace(URL_RE, " ");
  for (const d of withoutUrls.match(DOMAIN_RE) ?? []) out.add(`url:${trimUrl(d)}`);
  for (const p of text.match(PHONE_RE) ?? []) {
    const raw = p.trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15 || DATE_LIKE.test(raw)) continue;
    out.add(`tel:${digits}`);
  }
  return [...out].sort();
}

// ---- input --------------------------------------------------------------------------------------------

export interface PackItemForDraft {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly mime: string | null;
  readonly text: string | null;
}

export interface CheckedLineForDraft {
  readonly lineId: string;
  readonly line: string;
  readonly verdict: string;
  readonly lineCitation: { readonly evidence_item_id: string; readonly quote: string } | null;
  readonly citations: readonly { readonly evidence_item_id: string; readonly quote: string }[];
}

export interface DraftSource {
  readonly dispute: Omit<DraftInput["dispute"], "reason_unmapped" | "evidence_type">;
  readonly mapping: ReasonMapping;
  /** the pack's items in pack order (E1 first) */
  readonly items: readonly PackItemForDraft[];
  readonly facts: readonly { readonly evidenceItemId: string; readonly facts: Facts }[];
  /** the pack's latest scope check (M2-04) */
  readonly lines: readonly CheckedLineForDraft[];
}

/** What maps the model's refs back to the pack. */
export interface DraftRefs {
  readonly itemIdOf: ReadonlyMap<string, string>;
}

function factLines(f: Facts): Omit<DraftFact, "ref" | "evidence_ref">[] {
  const out: Omit<DraftFact, "ref" | "evidence_ref">[] = [];
  for (const p of f.parties) out.push({ type: "party", text: `${p.role}: ${p.name}` });
  for (const a of f.amounts) out.push({ type: "amount", text: `${a.value} ${a.currency} (${a.refers_to})` });
  for (const d of f.dates) out.push({ type: "date", text: `${d.date} (${d.refers_to})` });
  for (const d of f.deliverables) out.push({ type: "deliverable", text: `${d.kind}: ${d.description}` });
  for (const e of f.delivery_events)
    out.push({
      type: "delivery_event",
      text: `${e.event}${e.occurred_at ? ` on ${e.occurred_at}` : ""}: ${e.description}`,
    });
  if (f.shipment)
    out.push({ type: "shipment", text: `${f.shipment.carrier} tracking ${f.shipment.tracking_number}` });
  return out; // instruction_like_lines and source quotes stay out
}

const fileOf = (i: PackItemForDraft): DraftItem["file"] =>
  i.mime === "application/pdf" ? "pdf" : i.mime?.startsWith("image/") ? "image" : "text";

const isVerdict = (v: string): v is DraftLine["verdict"] => v === "met" || v === "partial" || v === "missing";

/** The workflow input (refs only) and the ref → uuid map. */
export function buildDraftInput(src: DraftSource): { input: DraftInput; refs: DraftRefs } {
  const refOf = new Map(src.items.map((i, n) => [i.id, `E${String(n + 1)}`] as const));
  const items: DraftItem[] = src.items.map((i, n) => ({
    ref: `E${String(n + 1)}`,
    kind: i.kind,
    added_on: i.createdAt.slice(0, 10),
    file: fileOf(i),
  }));
  const facts: DraftFact[] = [];
  for (const row of src.facts) {
    const evidenceRef = refOf.get(row.evidenceItemId);
    if (evidenceRef === undefined) continue;
    for (const f of factLines(row.facts))
      facts.push({ ref: `F${String(facts.length + 1)}`, evidence_ref: evidenceRef, ...f });
  }
  const lines: DraftLine[] = [];
  const quotes: DraftQuote[] = [];
  for (const l of src.lines) {
    if (!isVerdict(l.verdict)) continue; // unverifiable lines carry no verified support (M2-04)
    lines.push({
      ref: l.lineId,
      requirement: l.line,
      verdict: l.verdict,
      agreed: l.lineCitation?.quote ?? null,
    });
    for (const c of l.citations) {
      const evidenceRef = refOf.get(c.evidence_item_id);
      if (evidenceRef === undefined) continue;
      quotes.push({
        ref: `Q${String(quotes.length + 1)}`,
        line_ref: l.lineId,
        evidence_ref: evidenceRef,
        quote: c.quote,
      });
    }
  }
  const corpus = [
    ...src.items.map((i) => i.text ?? ""),
    ...facts.map((f) => f.text),
    JSON.stringify(src.dispute),
  ];
  const input: DraftInput = {
    dispute: {
      ...src.dispute,
      reason_unmapped: src.mapping.reasonUnmapped,
      evidence_type: src.mapping.evidenceType,
    },
    focus: src.mapping.focus,
    items,
    facts,
    lines,
    quotes,
    pack_contacts: contactsIn(corpus.join("\n")),
  };
  return {
    input,
    refs: { itemIdOf: new Map(items.map((i, n) => [i.ref, src.items[n]?.id ?? ""] as const)) },
  };
}

// ---- validators -----------------------------------------------------------------------------------------

/** Unicode code points (PayPal counts characters; `.length` would count UTF-16 units). */
export function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const low = s.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) i++; // a surrogate pair: one code point
    n++;
  }
  return n;
}

export const paragraphsOf = (notes: string): string[] =>
  notes
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

/** Every code check over the model's answer; `[]` passes. Each problem starts with its `DraftProblem` code. */
export function draftProblems(out: DraftOutput, input: DraftInput): string[] {
  const problems: string[] = [];
  const n = codePoints(out.notes);
  if (n > NOTES_MAX_CODE_POINTS)
    problems.push(
      `notes_too_long: the notes are ${String(n)} characters; PayPal's limit is ${String(NOTES_MAX_CODE_POINTS)}. Shorten them to at most 1,800 characters.`,
    );
  const itemRefs = new Set(input.items.map((i) => i.ref));
  for (const id of out.selected_evidence_item_ids)
    if (!ITEM_REF.test(id) || !itemRefs.has(id))
      problems.push(`unknown_evidence_id: ${id} is not an item in the pack index`);
  const known = new Set<string>([
    ...itemRefs,
    ...input.facts.map((f) => f.ref),
    ...input.lines.map((l) => l.ref),
    ...input.quotes.map((q) => q.ref),
  ]);
  const paragraphs = paragraphsOf(out.notes).length;
  for (const fr of out.fact_refs) {
    if (fr.paragraph > paragraphs)
      problems.push(
        `unresolved_fact_ref: paragraph ${String(fr.paragraph)} does not exist (${String(paragraphs)} paragraphs)`,
      );
    for (const r of fr.refs)
      if (!known.has(r)) problems.push(`unresolved_fact_ref: ${r} is not a ref in the data`);
  }
  const allowed = new Set(input.pack_contacts);
  for (const c of contactsIn(out.notes))
    if (!allowed.has(c))
      problems.push(`foreign_contact: ${c.replace(/^\w+:/, "")} is not in the evidence; remove it`);
  return problems;
}

/** The first problem code in a failed run's reason (the harness joins the problems with "; "). */
export function draftProblemOf(reason: string): DraftProblem | null {
  let best: { code: DraftProblem; at: number } | null = null;
  for (const code of DRAFT_PROBLEMS) {
    const at = reason.indexOf(`${code}:`);
    if (at >= 0 && (best === null || at < best.at)) best = { code, at };
  }
  return best?.code ?? null;
}

// ---- workflow -------------------------------------------------------------------------------------------

function dataBlocks(input: DraftInput): EvidenceInput[] {
  const block = (id: string, label: string, value: unknown): EvidenceInput => ({
    kind: "text",
    id,
    label,
    text: JSON.stringify(value),
  });
  // pack_contacts stay out: they are the notes check's allow-list, not data for the model
  return [
    block("D1", "dispute (PayPal's fields)", input.dispute),
    block("P1", "pack index (items to attach, by E ref)", input.items),
    block("F1", "extracted facts (earlier model output, by F ref)", input.facts),
    block("S1", "scope lines with code-checked verdicts (by C ref) and verified quotes (by Q ref)", {
      lines: input.lines,
      quotes: input.quotes,
    }),
  ];
}

export const draftDisputeWorkflow: WorkflowDef<DraftInput, DraftOutput> = {
  prompt: DRAFT_DISPUTE_PROMPT,
  schemaVersion: DRAFT_SCHEMA_VERSION,
  model: "large",
  outputSchema: DraftOutputSchema,
  async run(ctx, input) {
    return ctx.call({
      name: "draft",
      task: draftDisputeV1Task(input.dispute.evidence_type, input.focus),
      evidence: dataBlocks(input),
      schemaName: "dispute_draft_v1",
      schema: DraftOutputSchema,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      reasoningEffort: "low",
      validators: [(o) => draftProblems(o, input)],
    });
  },
};
