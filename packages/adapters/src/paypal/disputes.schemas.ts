// zod schemas for PayPal Customer Disputes v1 (https://developer.paypal.com/docs/api/customer-disputes/v1/).
// Statuses, stages and outcome codes mirror PayPal's documented enums; never invent one. Unknown extra
// fields are stripped. `links[]` is kept verbatim: it is the only source of allowed actions.
import { z } from "zod";
import { LinkSchema, MoneySchema } from "./schemas.ts";

export const DisputeStatusSchema = z.enum([
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
]);
export type DisputeStatus = z.infer<typeof DisputeStatusSchema>;

export const DisputeStageSchema = z.enum(["INQUIRY", "CHARGEBACK", "PRE_ARBITRATION", "ARBITRATION"]);
export type DisputeStage = z.infer<typeof DisputeStageSchema>;

export const DisputeOutcomeCodeSchema = z.enum([
  "RESOLVED_BUYER_FAVOUR",
  "RESOLVED_SELLER_FAVOUR",
  "RESOLVED_WITH_PAYOUT",
  "CANCELED_BY_BUYER",
  "ACCEPTED",
  "DENIED",
  "NONE",
]);
export type DisputeOutcomeCode = z.infer<typeof DisputeOutcomeCodeSchema>;

export const EvidenceSourceSchema = z.enum([
  "REQUESTED_FROM_BUYER",
  "REQUESTED_FROM_SELLER",
  "SUBMITTED_BY_BUYER",
  "SUBMITTED_BY_SELLER",
  "SUBMITTED_BY_PARTNER",
]);

const DocumentSchema = z.object({ name: z.string().optional(), url: z.string().optional() });

export const EvidenceSchema = z.object({
  evidence_type: z.string(),
  source: EvidenceSourceSchema.optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
  documents: z.array(DocumentSchema).optional(),
  dispute_life_cycle_stage: DisputeStageSchema.optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SupportingInfoSchema = z.object({
  notes: z.string().optional(),
  source: z.string().optional(),
  provided_time: z.string().optional(),
  dispute_life_cycle_stage: DisputeStageSchema.optional(),
  documents: z.array(DocumentSchema).optional(),
});

export const DisputeOutcomeSchema = z.object({
  outcome_code: DisputeOutcomeCodeSchema,
  outcome_reason: z.string().optional(),
  amount_refunded: MoneySchema.optional(),
});
export type DisputeOutcome = z.infer<typeof DisputeOutcomeSchema>;

export const DisputedTransactionSchema = z.object({
  seller_transaction_id: z.string().optional(),
  buyer_transaction_id: z.string().optional(),
  create_time: z.string().optional(),
  transaction_status: z.string().optional(),
  gross_amount: MoneySchema.optional(),
  custom: z.string().optional(),
  seller_protection_eligible: z.boolean().optional(),
});

export const DisputeSchema = z.object({
  dispute_id: z.string(),
  create_time: z.string(),
  update_time: z.string(),
  reason: z.string(),
  status: DisputeStatusSchema,
  dispute_state: z.string().optional(),
  dispute_amount: MoneySchema.optional(),
  dispute_life_cycle_stage: DisputeStageSchema,
  dispute_channel: z.string().optional(),
  external_reason_code: z.string().optional(),
  seller_response_due_date: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  disputed_transactions: z.array(DisputedTransactionSchema).optional(),
  evidences: z.array(EvidenceSchema).optional(),
  supporting_info: z.array(SupportingInfoSchema).optional(),
  dispute_outcome: DisputeOutcomeSchema.optional(),
  allowed_response_options: z
    .object({ accept_claim: z.object({ accept_claim_types: z.array(z.string()).optional() }).optional() })
    .optional(),
  links: z.array(LinkSchema),
});
export type Dispute = z.infer<typeof DisputeSchema>;

export const DisputeSummarySchema = z.object({
  dispute_id: z.string(),
  create_time: z.string(),
  update_time: z.string(),
  reason: z.string().optional(),
  status: DisputeStatusSchema,
  dispute_state: z.string().optional(),
  dispute_amount: MoneySchema.optional(),
  dispute_life_cycle_stage: DisputeStageSchema.optional(),
  links: z.array(LinkSchema).optional(),
});
export type DisputeSummary = z.infer<typeof DisputeSummarySchema>;

export const DisputeListSchema = z.object({
  items: z.array(DisputeSummarySchema).default([]),
  links: z.array(LinkSchema).optional(),
});
export type DisputeList = z.infer<typeof DisputeListSchema>;

/** `POST /v2/customer-support/process-chargeback` (sandbox). */
export const ChargebackResponseSchema = z.object({ dispute_id: z.string() });

/** The write endpoints answer with links (sometimes an empty body: parsed as `{}`). */
export const DisputeWriteResponseSchema = z.object({ links: z.array(LinkSchema).optional() });
export type DisputeWriteResponse = z.infer<typeof DisputeWriteResponseSchema>;
