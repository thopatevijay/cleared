// The proof-pack read contract (ADR 0003, M2-05): `GET /api/packs/:packId`, workspace-scoped. Everything
// the agent wrote (facts, rationales, quotes) is model output or evidence: data, rendered as plain text.
import { z } from "zod";
import { SYNC_SOURCES } from "../payments/payment.ts";
import { FactsSchema } from "../proof/facts-schema.ts";
import { PACK_STATES, VERDICTS } from "../proof/pack.ts";
import { PACK_VIEW_STATES } from "../proof/pack-view.ts";
import { LINE_NOTES } from "../proof/scope-schema.ts";
import { EvidenceItemResponseSchema } from "./evidence.ts";
import { AmountSchema } from "./payments.ts";

const QuoteInContextSchema = z.object({
  before: z.string(),
  quote: z.string(),
  after: z.string(),
  exact: z.boolean(),
});

export const PackCitationSchema = z.object({
  evidenceItemId: z.uuid(),
  /** the stored verified quote */
  quote: z.string(),
  offsets: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  /** the quote cut from the item's normalised text at its offsets; null if the item has no text */
  context: QuoteInContextSchema.nullable(),
});
export type PackCitation = z.infer<typeof PackCitationSchema>;

export const PackVerdictSchema = z.object({
  lineId: z.string(),
  line: z.string(),
  verdict: z.enum(VERDICTS),
  note: z.enum(LINE_NOTES).nullable(),
  rationale: z.string(),
  lineCitation: PackCitationSchema.nullable(),
  citations: z.array(PackCitationSchema),
});
export type PackVerdict = z.infer<typeof PackVerdictSchema>;

export const PackEvidenceSchema = EvidenceItemResponseSchema.extend({
  /** text that looks like instructions (scan or the extract step's report): shown, treated as data */
  injectionFlagged: z.boolean(),
});
export type PackEvidence = z.infer<typeof PackEvidenceSchema>;

export const PackFactsSchema = z.object({ evidenceItemId: z.uuid(), facts: FactsSchema });

export const PackViewSchema = z.object({
  pack: z.object({
    id: z.uuid(),
    paymentId: z.uuid(),
    state: z.enum(PACK_STATES),
    view: z.enum(PACK_VIEW_STATES),
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  payment: z.object({
    id: z.uuid(),
    captureId: z.string(),
    orderId: z.string().nullable(),
    amount: AmountSchema,
    receivable: AmountSchema.nullable(),
    status: z.string(),
    statusReason: z.string().nullable(),
    source: z.enum(SYNC_SOURCES),
    capturedAt: z.iso.datetime({ offset: true }),
  }),
  /** the latest check; `previous` = true while the pack is stale (verdicts from before the new evidence) */
  check: z
    .object({
      version: z.number().int().min(1),
      at: z.iso.datetime({ offset: true }),
      previous: z.boolean(),
      verdicts: z.array(PackVerdictSchema),
    })
    .nullable(),
  facts: z.array(PackFactsSchema),
  /** newest first */
  evidence: z.array(PackEvidenceSchema),
  workspace: z.object({ timezone: z.string() }),
});
export type PackView = z.infer<typeof PackViewSchema>;
