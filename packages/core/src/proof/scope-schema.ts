// `scope@v1` (M2-04, ADR 0009): the two model answers of `check_scope@v1` and the checked result the code
// builds from them. The model-facing shapes keep the M0-07 spike's field names, so the recorded spike
// answers (`fixtures/openai/scope-pass{1,2}/*`) replay unchanged. Strict structured outputs need every
// property required: "absent" is null or [].
import { z } from "zod";
import { VERDICTS } from "./pack.ts";
import { CITATION_REJECTIONS } from "./verbatim.ts";

export const SCOPE_SCHEMA_VERSION = "scope@v1";

const EVIDENCE_REF = z.string().regex(/^E\d{1,3}$/);
export const LINE_ID = z.string().regex(/^C\d{1,3}$/);
/** The schema bound is loose on purpose: an over-long quote is dropped by the verbatim check (500), not repaired. */
const MODEL_QUOTE = z.string().max(2_000);

/** Pass 1: the scope lines (what was agreed), each anchored in a scope or chat quote. */
export const ScopeLinesSchema = z.object({
  claims: z
    .array(
      z.object({
        claim_id: LINE_ID,
        requirement: z.string().max(300),
        source_evidence_id: EVIDENCE_REF,
        source_quote: MODEL_QUOTE,
      }),
    )
    .min(1)
    .max(25),
});
export type ScopeLines = z.infer<typeof ScopeLinesSchema>;

/** The model may also say it cannot decide; code turns that into `unverifiable` too. */
export const ModelVerdict = z.enum(VERDICTS);

/** Pass 2: one verdict per line, with quoted spans. */
export const ScopeVerdictsSchema = z.object({
  verdicts: z
    .array(
      z.object({
        claim_id: LINE_ID,
        verdict: ModelVerdict,
        rationale: z.string().max(500),
        citations: z.array(z.object({ evidence_id: EVIDENCE_REF, quote: MODEL_QUOTE })).max(6),
      }),
    )
    .min(1)
    .max(25),
});
export type ScopeVerdicts = z.infer<typeof ScopeVerdictsSchema>;

/**
 * Why a line is `unverifiable` (null when it is not):
 * - `no_valid_citation`: met/partial with no citation that passed the verbatim check
 * - `image_only_support`: met/partial whose support points only at items without text (screenshots)
 * - `no_scope_quote`: missing, but the line's own scope quote did not verify
 * - `model_unverifiable`: the model itself could not decide
 */
export const LINE_NOTES = [
  "no_valid_citation",
  "image_only_support",
  "no_scope_quote",
  "model_unverifiable",
] as const;
export type LineNote = (typeof LINE_NOTES)[number];

/** A verified span: `normaliseForQuote(item.text).slice(start, end) === quote`, and the item's sha256. */
export const CitationSchema = z.object({
  evidence_ref: EVIDENCE_REF,
  quote: z.string().min(1).max(2_000),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Citation = z.infer<typeof CitationSchema>;

/** A citation the code dropped, and why (kept in the run output for M4-02's citation metric). */
export const DroppedCitationSchema = z.object({
  evidence_ref: z.string(),
  reason: z.enum([...CITATION_REJECTIONS, "not_support", "instruction_like"]),
});
export type DroppedCitation = z.infer<typeof DroppedCitationSchema>;

export const CheckedLineSchema = z.object({
  line_id: LINE_ID,
  requirement: z.string(),
  /** the verified scope quote the line came from, or null */
  line_citation: CitationSchema.nullable(),
  model_verdict: ModelVerdict,
  verdict: z.enum(VERDICTS),
  note: z.enum(LINE_NOTES).nullable(),
  rationale: z.string(),
  /** verified support (met / partial) or gap (missing) citations; [] whenever the verdict is unverifiable */
  citations: z.array(CitationSchema),
  dropped: z.array(DroppedCitationSchema),
});
export type CheckedLine = z.infer<typeof CheckedLineSchema>;

/** The workflow's output (stored in `agent_runs.output`; the job writes one `scope_checks` row per line). */
export const ScopeCheckResultSchema = z.object({ lines: z.array(CheckedLineSchema).min(1) });
export type ScopeCheckResult = z.infer<typeof ScopeCheckResultSchema>;
