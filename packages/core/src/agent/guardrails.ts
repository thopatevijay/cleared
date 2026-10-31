// Guardrails (ADR 0010, architecture §10). Evidence is data, never instructions:
// - input: every evidence item becomes a delimited data block with its sha256; an injection scan flags
//   instruction-like text, records the flag and wraps the text again. Nothing is ever dropped.
// - output: zod parse plus workflow validators (the harness allows one repair attempt).
// - action: the only write is a proposal; its kind must be agent-proposable and its payload must
//   parse; payload_sha256 = canonicalHash(payload).
import { z } from "zod";
import { ACTION_KINDS, type ActionKind, type ActionRisk } from "../actions/action.ts";
import type { JsonValue } from "../actions/canonical-json.ts";
import type { Sha256 } from "../ids.ts";
import type { DataBlock } from "../ports/ai-provider.ts";
import { canonicalHash, sha256Hex } from "./canonical-hash.ts";

// ---- input ---------------------------------------------------------------------------------------

export type EvidenceInput =
  | { readonly kind: "text"; readonly id: string; readonly label: string; readonly text: string }
  | {
      readonly kind: "image";
      readonly id: string;
      readonly label: string;
      readonly mimeType: "image/png" | "image/jpeg" | "image/gif";
      readonly base64: string;
    }
  | {
      readonly kind: "pdf";
      readonly id: string;
      readonly label: string;
      readonly filename: string;
      readonly base64: string;
      /** the PDF's text layer, scanned for injection (the bytes go to the model unchanged) */
      readonly textLayer: string | null;
    };

export const INJECTION_PATTERNS = ["instruction_verb", "role_tag", "delimiter_break", "base64_blob"] as const;
export type InjectionPattern = (typeof INJECTION_PATTERNS)[number];

export interface InjectionFlag {
  readonly evidenceId: string;
  readonly pattern: InjectionPattern;
  /** the matched text, truncated to 80 chars (for the step trace) */
  readonly match: string;
}

const RULES: readonly (readonly [InjectionPattern, RegExp])[] = [
  // instruction verbs aimed at the model
  [
    "instruction_verb",
    /\b(ignore|disregard|forget|override|bypass)\b[^\n]{0,40}?\b(previous|prior|above|earlier|all|any|your|these|the)\b[^\n]{0,30}?\b(instructions?|prompts?|rules?|guidelines?|directions?|system prompt)\b/i,
  ],
  [
    "instruction_verb",
    /\b(you are now|from now on,? you|act as|pretend to be|as an? (ai|language model|assistant|reviewer))\b/i,
  ],
  [
    "instruction_verb",
    /\b(ai|assistant|model|llm|chatgpt|gpt|reviewer|system)\b[^\n]{0,30}?\b(must|should|shall|will)\b[^\n]{0,30}?\b(accept|approve|rule|decide|refund|grant|mark|output|respond|say)\b/i,
  ],
  // role tags and chat-template markers
  ["role_tag", /<\s*\/?\s*(system|assistant|user|developer|instructions?|tool)\s*>/i],
  ["role_tag", /^\s*(system|assistant|developer)\s*:/im],
  ["role_tag", /\[\/?INST\]|<\|im_(start|end)\|>|<\|(system|user|assistant)\|>/i],
  // an attempt to close or open our own delimiters
  ["delimiter_break", /<\s*\/?\s*(evidence|untrusted)\b/i],
  // long base64 runs (encoded payloads)
  ["base64_blob", /[A-Za-z0-9+/]{160,}={0,2}/],
];

/** Every pattern that matches `text` (one flag per pattern kind). */
export function scanForInjection(evidenceId: string, text: string): InjectionFlag[] {
  const seen = new Set<InjectionPattern>();
  const flags: InjectionFlag[] = [];
  for (const [pattern, re] of RULES) {
    if (seen.has(pattern)) continue;
    const m = re.exec(text);
    if (!m) continue;
    seen.add(pattern);
    flags.push({ evidenceId, pattern, match: m[0].slice(0, 80) });
  }
  return flags;
}

/** Neutralises our delimiters inside data so an item cannot close its own block or marker. */
export function escapeDelimiters(text: string): string {
  return text.replace(/<(\s*\/?\s*)(evidence|untrusted)\b/gi, "&lt;$1$2");
}

/** Flagged text is wrapped again; the content itself is kept, character for character apart from delimiters. */
export function wrapFlagged(text: string, flags: readonly InjectionFlag[]): string {
  const kinds = [...new Set(flags.map((f) => f.pattern))].join(",");
  return `<untrusted flags="${kinds}">\n${escapeDelimiters(text)}\n</untrusted>`;
}

export interface GuardedInput {
  readonly blocks: DataBlock[];
  readonly flags: InjectionFlag[];
}

function base64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function textBlock(item: Extract<EvidenceInput, { kind: "text" }>, flags: InjectionFlag[]): DataBlock {
  const base = { id: item.id, label: item.label, sha256: sha256Hex(item.text), flagged: flags.length > 0 };
  const text = flags.length > 0 ? wrapFlagged(item.text, flags) : escapeDelimiters(item.text);
  return { ...base, kind: "text", text };
}

/** Input guardrail: evidence → data blocks + flags. Every item comes back; none is dropped. */
export function guardInput(items: readonly EvidenceInput[]): GuardedInput {
  const blocks: DataBlock[] = [];
  const flags: InjectionFlag[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      const f = scanForInjection(item.id, `${item.label}\n${item.text}`);
      flags.push(...f);
      blocks.push(textBlock(item, f));
      continue;
    }
    const f = item.kind === "pdf" && item.textLayer ? scanForInjection(item.id, item.textLayer) : [];
    flags.push(...f);
    const base = {
      id: item.id,
      label: item.label,
      sha256: sha256Hex(base64Bytes(item.base64)),
      flagged: f.length > 0,
    };
    blocks.push(
      item.kind === "image"
        ? { ...base, kind: "image", mimeType: item.mimeType, base64: item.base64 }
        : { ...base, kind: "pdf", filename: item.filename, base64: item.base64 },
    );
  }
  return { blocks, flags };
}

/** Shortest evidence span the system-channel check looks for (shorter strings match by chance). */
const MIN_LEAK_CHARS = 24;

/**
 * Throws when any evidence text appears in our own channels (system prompt or task text). A workflow
 * that interpolates evidence into its instructions is a bug, so the harness stops the run.
 */
export function assertNoEvidenceIn(channel: string, items: readonly EvidenceInput[]): void {
  for (const item of items) {
    const texts =
      item.kind === "text" ? [item.text] : item.kind === "pdf" && item.textLayer ? [item.textLayer] : [];
    for (const t of texts) {
      for (const line of t.split("\n")) {
        const s = line.trim();
        if (s.length >= MIN_LEAK_CHARS && channel.includes(s))
          throw new Error(`evidence ${item.id} text found in the instruction channel`);
      }
    }
  }
}

// ---- output --------------------------------------------------------------------------------------

/** A workflow-specific check over parsed output (M2-04 verbatim quotes, M2-07 length/IDs). [] = pass. */
export type OutputValidator<T> = (output: T) => readonly string[];

export type OutputCheck<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: string[] };

export function checkOutput<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  validators: readonly OutputValidator<z.infer<S>>[],
): OutputCheck<z.infer<S>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: [z.prettifyError(parsed.error)] };
  const problems = validators.flatMap((v) => v(parsed.data));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: parsed.data };
}

// ---- action --------------------------------------------------------------------------------------

/** `accept_claim` is never agent-created (ADR 0010): it needs the seller's typed confirmation. */
export const AGENT_PROPOSABLE_KINDS = [
  "add_tracking",
  "provide_evidence",
  "provide_supporting_info",
] as const;
export type AgentProposableKind = (typeof AGENT_PROPOSABLE_KINDS)[number];

const disputeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
const notes = z.string().min(1).max(2000);
const evidenceItemIds = z.array(z.uuid()).max(20);

export const PROPOSAL_PAYLOAD_SCHEMAS = {
  add_tracking: z.strictObject({
    capture_id: disputeId,
    carrier: z.string().min(1).max(64),
    tracking_number: z.string().min(1).max(64),
    notify_payer: z.literal(false),
  }),
  provide_evidence: z.strictObject({ dispute_id: disputeId, notes, evidence_item_ids: evidenceItemIds }),
  provide_supporting_info: z.strictObject({
    dispute_id: disputeId,
    notes,
    evidence_item_ids: evidenceItemIds,
  }),
} as const satisfies Record<AgentProposableKind, z.ZodType>;

export const ACTION_RISK_BY_KIND: Readonly<Record<ActionKind, ActionRisk>> = {
  add_tracking: "low",
  provide_supporting_info: "medium",
  provide_evidence: "high",
  accept_claim: "high",
};

export interface CheckedProposal {
  readonly kind: AgentProposableKind;
  readonly payload: JsonValue;
  readonly payloadSha256: Sha256;
  readonly risk: ActionRisk;
}

export const PROPOSAL_REFUSALS = ["kind_not_allowed", "invalid_payload", "kill_switch_on"] as const;
export type ProposalRefusal = (typeof PROPOSAL_REFUSALS)[number];

export type ProposalCheck =
  | { readonly ok: true; readonly proposal: CheckedProposal }
  | { readonly ok: false; readonly reason: ProposalRefusal; readonly detail: string };

function isProposable(kind: string): kind is AgentProposableKind {
  return (AGENT_PROPOSABLE_KINDS as readonly string[]).includes(kind);
}

/** Action guardrail: refuses non-proposable kinds in code and validates the payload per kind. */
export function checkProposal(kind: string, payload: unknown): ProposalCheck {
  if (!(ACTION_KINDS as readonly string[]).includes(kind) || !isProposable(kind))
    return { ok: false, reason: "kind_not_allowed", detail: `the agent may not propose ${kind}` };
  const parsed = PROPOSAL_PAYLOAD_SCHEMAS[kind].safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "invalid_payload", detail: z.prettifyError(parsed.error) };
  const value = parsed.data as JsonValue;
  return {
    ok: true,
    proposal: { kind, payload: value, payloadSha256: canonicalHash(value), risk: ACTION_RISK_BY_KIND[kind] },
  };
}
