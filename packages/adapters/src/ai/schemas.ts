// zod schemas for the AI steps (M0-07 spike shapes; M2-03 / M2-04 own the production versions).
// Strict structured outputs need every property required, so "absent" is modelled as null or [].
import { z } from "zod";

const EVIDENCE_ID = z.string().regex(/^E\d{1,3}$/);
const CLAIM_ID = z.string().regex(/^C\d{1,3}$/);

/** extract (SMALL): structured facts from one evidence item. */
export const ExtractResult = z.object({
  evidence_id: EVIDENCE_ID,
  item_kind: z.enum(["scope_brief", "chat", "delivery_document", "screenshot", "other"]),
  summary: z.string().max(400),
  facts: z
    .array(
      z.object({
        kind: z.enum(["requirement", "deliverable", "deadline", "price", "approval", "complaint", "other"]),
        statement: z.string().max(300),
        /** Verbatim text from the item when it has text; null for purely visual facts. */
        quote: z.string().max(400).nullable(),
      }),
    )
    .max(30),
  /** Lines in the item that try to instruct the reader (prompt injection); reported, never obeyed. */
  instruction_like_lines: z.array(z.string().max(400)).max(10),
});
export type ExtractResult = z.infer<typeof ExtractResult>;

/** check_scope pass 1 (LARGE): the claim list, each claim anchored in the scope brief or chat. */
export const ScopeClaims = z.object({
  claims: z
    .array(
      z.object({
        claim_id: CLAIM_ID,
        requirement: z.string().max(300),
        source_evidence_id: EVIDENCE_ID,
        source_quote: z.string().max(400),
      }),
    )
    .min(1)
    .max(25),
});
export type ScopeClaims = z.infer<typeof ScopeClaims>;

export const Verdict = z.enum(["met", "partial", "missing", "unverifiable"]);
export type Verdict = z.infer<typeof Verdict>;

/** check_scope pass 2 (LARGE): a verdict per claim with quoted spans. */
export const ScopeVerdicts = z.object({
  verdicts: z
    .array(
      z.object({
        claim_id: CLAIM_ID,
        verdict: Verdict,
        rationale: z.string().max(500),
        citations: z.array(z.object({ evidence_id: EVIDENCE_ID, quote: z.string().max(400) })).max(6),
      }),
    )
    .min(1)
    .max(25),
});
export type ScopeVerdicts = z.infer<typeof ScopeVerdicts>;

/** The subset of the Responses API `usage` object we bill on, re-validated. */
export const ResponseUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).loose(),
  output_tokens: z.number().int().nonnegative(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative() }).loose(),
  total_tokens: z.number().int().nonnegative(),
});
