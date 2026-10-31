// The `check_scope@v1` workflow (M2-04, ADR 0009, pillar P1): one pack → a verdict per scope line, on the
// LARGE model, two passes in one harness run (≤ 6 calls with repairs: the harness limit).
//   pass 1: scope lines from the scope / chat evidence (+ their extracted facts)
//   pass 2: met | partial | missing per line, with citations
// The citation guarantee is ours, not the model's: after the harness has parsed each answer (schema +
// structural validators, one repair), `checkLines` runs the verbatim check on every quote. A failing quote is
// dropped (never repaired), and a line left without valid support becomes `unverifiable` whatever the model
// said. Support comes only from delivery / communication / shipment / invoice text, never from the scope
// itself, and never from a line that reads as an instruction to the reviewer (injection).
import type { EvidenceInput } from "../agent/guardrails.ts";
import { scanForInjection } from "../agent/guardrails.ts";
import type { WorkflowDef } from "../agent/harness.ts";
import { definePrompt, PROMPTS } from "../agent/prompts.ts";
import type { EvidenceKind } from "./evidence.ts";
import { evidenceBlockOf, type ExtractContent } from "./extract.ts";
import type { Facts } from "./facts-schema.ts";
import {
  CHECK_SCOPE_V1_ID,
  CHECK_SCOPE_V1_PASS1_TASK,
  CHECK_SCOPE_V1_PASS2_TASK,
  CHECK_SCOPE_V1_SYSTEM,
} from "./prompts/check-scope.v1.ts";
import {
  SCOPE_SCHEMA_VERSION,
  ScopeCheckResultSchema,
  ScopeLinesSchema,
  ScopeVerdictsSchema,
  type CheckedLine,
  type Citation,
  type DroppedCitation,
  type LineNote,
  type ScopeCheckResult,
  type ScopeLines,
  type ScopeVerdicts,
} from "./scope-schema.ts";
import { citationIndex, normaliseForQuote, verifyCitation, type CitationIndex } from "./verbatim.ts";

export const CHECK_SCOPE_PROMPT = PROMPTS.register(definePrompt(CHECK_SCOPE_V1_ID, CHECK_SCOPE_V1_SYSTEM));
/** M0-07 measured pass 1 ≤ 329 and pass 2 ≤ 877 output tokens; these are its suggested caps. */
export const PASS1_MAX_OUTPUT_TOKENS = 2_000;
export const PASS2_MAX_OUTPUT_TOKENS = 4_000;
/** Pass 1 reads these kinds (what was agreed). */
export const SCOPE_KINDS: readonly EvidenceKind[] = ["scope", "scope_snapshot", "communication"];
/** A met / partial / missing citation must come from one of these kinds (never the scope itself). */
export const SUPPORT_KINDS: readonly EvidenceKind[] = ["delivery", "communication", "shipment", "invoice"];
/** An instruction-like line shorter than this is not matched against citations (too likely by chance). */
const MIN_INSTRUCTION_CHARS = 16;

/** One pack item, by block ref (`E1`, in pack order). Text first (text layer for PDFs), else the file. */
export type ScopeItemInput = {
  readonly ref: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly content: ExtractContent;
};

/** The workflow input (the cache key): content and hashes, no uuids. `facts` are keyed by ref too. */
export type ScopeCheckInput = {
  readonly items: readonly ScopeItemInput[];
  readonly facts: readonly { readonly ref: string; readonly facts: Facts }[];
};

const isScope = (i: ScopeItemInput): boolean => SCOPE_KINDS.includes(i.kind);

/** Pass 1's facts block: an earlier model's reading of the scope items (hints, never quoted). */
function factsBlock(input: ScopeCheckInput, refs: ReadonlySet<string>): EvidenceInput[] {
  const facts = input.facts
    .filter((f) => refs.has(f.ref))
    .map(({ ref, facts: f }) => ({
      evidence_id: ref,
      parties: f.parties,
      amounts: f.amounts,
      dates: f.dates,
      deliverables: f.deliverables,
      delivery_events: f.delivery_events,
      shipment: f.shipment,
    })); // instruction_like_lines stay out: they are what the model must not read as instructions
  if (facts.length === 0) return [];
  const text = JSON.stringify(facts);
  return [{ kind: "text", id: "F1", label: "extracted facts (earlier model output, not quotable)", text }];
}

function linesBlock(lines: ScopeLines): EvidenceInput {
  const text = JSON.stringify(
    lines.claims.map((c) => ({ claim_id: c.claim_id, requirement: c.requirement })),
  );
  return { kind: "text", id: "L1", label: "step-1 lines (not quotable)", text };
}

export function lineProblems(lines: ScopeLines, scopeRefs: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of lines.claims) {
    if (seen.has(c.claim_id)) problems.push(`claim_id ${c.claim_id} appears twice`);
    seen.add(c.claim_id);
    if (!scopeRefs.has(c.source_evidence_id))
      problems.push(
        `${c.claim_id}: source_evidence_id ${c.source_evidence_id} is not one of the evidence blocks`,
      );
  }
  return problems;
}

export function verdictProblems(verdicts: ScopeVerdicts, lines: ScopeLines): string[] {
  const want = lines.claims.map((c) => c.claim_id);
  const got = verdicts.verdicts.map((v) => v.claim_id);
  const problems: string[] = [];
  for (const id of want) {
    const n = got.filter((g) => g === id).length;
    if (n !== 1) problems.push(`line ${id} needs exactly one verdict (got ${String(n)})`);
  }
  for (const id of new Set(got))
    if (!want.includes(id)) problems.push(`${id} is not one of the step-1 lines`);
  return problems;
}

export const checkScopeWorkflow: WorkflowDef<ScopeCheckInput, ScopeCheckResult> = {
  prompt: CHECK_SCOPE_PROMPT,
  schemaVersion: SCOPE_SCHEMA_VERSION,
  model: "large",
  outputSchema: ScopeCheckResultSchema,
  async run(ctx, input) {
    const scopeItems = input.items.filter(isScope);
    if (scopeItems.length === 0) throw new Error("check_scope: the pack has no scope or chat evidence");
    const scopeRefs = new Set(scopeItems.map((i) => i.ref));
    const lines = await ctx.call({
      name: "pass1",
      task: CHECK_SCOPE_V1_PASS1_TASK,
      evidence: [...scopeItems.map(evidenceBlockOf), ...factsBlock(input, scopeRefs)],
      schemaName: "scope_lines_v1",
      schema: ScopeLinesSchema,
      maxOutputTokens: PASS1_MAX_OUTPUT_TOKENS,
      reasoningEffort: "low",
      validators: [(l) => lineProblems(l, scopeRefs)],
    });
    const verdicts = await ctx.call({
      name: "pass2",
      task: CHECK_SCOPE_V1_PASS2_TASK,
      evidence: [linesBlock(lines), ...input.items.map(evidenceBlockOf)],
      schemaName: "scope_verdicts_v1",
      schema: ScopeVerdictsSchema,
      maxOutputTokens: PASS2_MAX_OUTPUT_TOKENS,
      reasoningEffort: "low",
      validators: [(v) => verdictProblems(v, lines)],
    });
    return { lines: checkLines(input, lines, verdicts) };
  },
};

// ---- the deterministic part ---------------------------------------------------------------------------

type Span = readonly [number, number];

/** Normalised spans of every instruction-like line per ref: injection-scan hits plus the facts' reports. */
export function instructionSpans(input: ScopeCheckInput, index: CitationIndex): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const item of input.items) {
    const norm = index.get(item.ref)?.norm;
    if (norm == null || item.content.type !== "text") continue;
    const scanned = item.content.text
      .split(/\r\n?|\n/)
      .filter((l) => scanForInjection(item.ref, l).length > 0);
    const reported = input.facts
      .filter((f) => f.ref === item.ref)
      .flatMap((f) => f.facts.instruction_like_lines);
    const spans: Span[] = [];
    for (const line of [...scanned, ...reported]) {
      const needle = normaliseForQuote(line).trim();
      if (needle.length < MIN_INSTRUCTION_CHARS) continue;
      for (let at = norm.indexOf(needle); at >= 0; at = norm.indexOf(needle, at + 1))
        spans.push([at, at + needle.length]);
    }
    out.set(item.ref, spans);
  }
  return out;
}

interface Checked {
  readonly valid: Citation[];
  readonly dropped: DroppedCitation[];
}

function checkSupport(
  cites: ScopeVerdicts["verdicts"][number]["citations"],
  index: CitationIndex,
  kinds: ReadonlyMap<string, EvidenceKind>,
  spans: ReadonlyMap<string, readonly Span[]>,
): Checked {
  const valid: Citation[] = [];
  const dropped: DroppedCitation[] = [];
  for (const c of cites) {
    const r = verifyCitation(c.evidence_id, c.quote, index);
    const drop = (reason: DroppedCitation["reason"]): void => {
      dropped.push({ evidence_ref: c.evidence_id, reason });
    };
    if (!r.ok) drop(r.reason);
    else if (!SUPPORT_KINDS.includes(kinds.get(r.ref) ?? "scope")) drop("not_support");
    else if ((spans.get(r.ref) ?? []).some(([s, e]) => r.start < e && s < r.end)) drop("instruction_like");
    else if (!valid.some((v) => v.evidence_ref === r.ref && v.start === r.start && v.end === r.end))
      valid.push({ evidence_ref: r.ref, quote: r.quote, start: r.start, end: r.end, sha256: r.sha256 });
  }
  return { valid, dropped };
}

/** The verdict rules (ticket M2-04): what the code stores, whatever the model said. */
function decide(
  modelVerdict: CheckedLine["model_verdict"],
  support: Checked,
  lineCitation: Citation | null,
): Pick<CheckedLine, "verdict" | "note" | "citations"> {
  const unverifiable = (note: LineNote) => ({ verdict: "unverifiable" as const, note, citations: [] });
  if (modelVerdict === "unverifiable") return unverifiable("model_unverifiable");
  if (modelVerdict === "missing")
    return lineCitation
      ? { verdict: "missing", note: null, citations: support.valid }
      : unverifiable("no_scope_quote");
  if (support.valid.length > 0) return { verdict: modelVerdict, note: null, citations: support.valid };
  return unverifiable(
    support.dropped.some((d) => d.reason === "no_text") ? "image_only_support" : "no_valid_citation",
  );
}

/** Runs the verbatim check on both passes' quotes and applies the verdict rules, line by line. */
export function checkLines(
  input: ScopeCheckInput,
  lines: ScopeLines,
  verdicts: ScopeVerdicts,
): CheckedLine[] {
  const index = citationIndex(
    input.items.map((i) => ({
      ref: i.ref,
      sha256: i.sha256,
      text: i.content.type === "text" ? i.content.text : null,
    })),
  );
  const kinds = new Map(input.items.map((i) => [i.ref, i.kind] as const));
  const spans = instructionSpans(input, index);
  return lines.claims.map((claim) => {
    const v = verdicts.verdicts.find((x) => x.claim_id === claim.claim_id);
    if (!v) throw new Error(`check_scope: no verdict for ${claim.claim_id}`); // the validator guarantees one
    const src = SCOPE_KINDS.includes(kinds.get(claim.source_evidence_id) ?? "delivery")
      ? verifyCitation(claim.source_evidence_id, claim.source_quote, index)
      : null;
    const lineCitation: Citation | null = src?.ok
      ? { evidence_ref: src.ref, quote: src.quote, start: src.start, end: src.end, sha256: src.sha256 }
      : null;
    const support = checkSupport(v.citations, index, kinds, spans);
    return {
      line_id: claim.claim_id,
      requirement: claim.requirement,
      line_citation: lineCitation,
      model_verdict: v.verdict,
      ...decide(v.verdict, support, lineCitation),
      rationale: v.rationale,
      dropped: support.dropped,
    };
  });
}
