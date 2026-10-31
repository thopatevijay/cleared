// The `extract@v1` workflow (M2-03, ADR 0009): one evidence item → `facts@v1`, on the SMALL model through
// the M2-02 harness (limits, budgets, guardrails, traces, content-hash cache). The item travels only in a
// harness data block: text items (and PDFs with a text layer) as text, images and image-only PDFs as image /
// PDF parts. The input names the item by its block ref (`E1`), never its uuid, so identical canned evidence
// hits the content-hash cache; the caller maps the ref back to the item's uuid (`withEvidenceIds`).
import type { EvidenceInput, InjectionFlag } from "../agent/guardrails.ts";
import type { WorkflowDef } from "../agent/harness.ts";
import { definePrompt, PROMPTS } from "../agent/prompts.ts";
import type { EvidenceKind } from "./evidence.ts";
import { factProblems, FACTS_SCHEMA_VERSION, FactsSchema, type Facts } from "./facts-schema.ts";
import { EXTRACT_V1_ID, EXTRACT_V1_SYSTEM, EXTRACT_V1_TASK } from "./prompts/extract.v1.ts";

export const EXTRACT_PROMPT = PROMPTS.register(definePrompt(EXTRACT_V1_ID, EXTRACT_V1_SYSTEM));
/** M0-07 suggested 1,500 for its smaller schema; facts@v1 on a long chat measured up to ~1,350 (M2-03). */
export const EXTRACT_MAX_OUTPUT_TOKENS = 2_500;
/** The one block ref an extract call uses. */
export const EXTRACT_REF = "E1";

export type ExtractImageMime = "image/png" | "image/jpeg" | "image/gif";
const IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/gif"] satisfies ExtractImageMime[];

export type ExtractContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: ExtractImageMime; readonly base64: string }
  | { readonly type: "pdf"; readonly filename: string; readonly base64: string };

/** The workflow input (part of the cache key): content and its hash, no uuid. */
export type ExtractInput = {
  readonly ref: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly content: ExtractContent;
};

/** What the caller knows about a stored item (M2-01): its text, or its file's mime and bytes. */
export interface StoredEvidence {
  readonly kind: EvidenceKind;
  readonly sha256: string;
  /** pasted text or a PDF's text layer; null for images and image-only PDFs */
  readonly text: string | null;
  readonly file: { readonly mime: string; readonly base64: string } | null;
}

/**
 * Text first (pasted text, a PDF's text layer: quotable, scanned for injection); else the file's bytes as
 * an image or PDF part. `null` when the item has neither (nothing to extract).
 */
export function extractInputFor(item: StoredEvidence, ref = EXTRACT_REF): ExtractInput | null {
  const base = { ref, kind: item.kind, sha256: item.sha256 };
  if (item.text !== null && item.text.trim() !== "")
    return { ...base, content: { type: "text", text: item.text } };
  if (item.file === null) return null;
  const { mime, base64 } = item.file;
  if (IMAGE_MIMES.includes(mime))
    return { ...base, content: { type: "image", mimeType: mime as ExtractImageMime, base64 } };
  if (mime === "application/pdf")
    return { ...base, content: { type: "pdf", filename: `${ref}.pdf`, base64 } };
  return null;
}

/** One item as a harness data block (`<kind> evidence`); M2-04 reuses it for the scope check. */
export function evidenceBlockOf(input: Pick<ExtractInput, "ref" | "kind" | "content">): EvidenceInput {
  const head = { id: input.ref, label: `${input.kind} evidence` };
  const c = input.content;
  if (c.type === "text") return { ...head, kind: "text", text: c.text };
  if (c.type === "image") return { ...head, kind: "image", mimeType: c.mimeType, base64: c.base64 };
  return { ...head, kind: "pdf", filename: c.filename, base64: c.base64, textLayer: null };
}

export const extractWorkflow: WorkflowDef<ExtractInput, Facts> = {
  prompt: EXTRACT_PROMPT,
  schemaVersion: FACTS_SCHEMA_VERSION,
  model: "small",
  outputSchema: FactsSchema,
  run(ctx, input) {
    return ctx.call({
      name: "extract",
      task: EXTRACT_V1_TASK,
      evidence: [evidenceBlockOf(input)],
      schemaName: "facts_v1",
      schema: FactsSchema,
      maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
      reasoningEffort: "none",
      validators: [(facts) => factProblems(facts, [input.ref])],
      // the input scan reads text only: for an image or image-only PDF, what the model reports is the flag
      ...(input.content.type === "text"
        ? {}
        : { reportedFlags: (facts: Facts) => reportedFlags(input.ref, facts) }),
    });
  },
};

/** BL-01 6537070412: the item's `instruction_like_lines`, as step flags (`model_reported`, ≤ 80 chars each). */
export function reportedFlags(ref: string, facts: Facts): InjectionFlag[] {
  return facts.instruction_like_lines.map((line) => ({
    evidenceId: ref,
    pattern: "model_reported",
    match: line.slice(0, 80),
  }));
}
