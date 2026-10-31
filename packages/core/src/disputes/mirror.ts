// PayPal dispute body -> the stored mirror (M2-06). Mirror only: status, stage and outcome are PayPal's
// strings (unknown values kept verbatim); allowed actions are the `rel`s of the dispute's CURRENT links
// and nothing else (never a status map). Pure: the adapter fetches, the worker stores.
import { z } from "zod";
import { domainError, type DomainError } from "../errors.ts";
import { CaptureIdSchema, DisputeIdSchema, type CaptureId, type DisputeId } from "../ids.ts";
import { err, ok, type Result } from "../result.ts";
import { parseInstant, type Instant } from "../time.ts";
import { mapDisputeState, type DisputeMirrorState } from "./dispute.ts";

/** The fields of a PayPal dispute body Cleared reads. Everything else is ignored, never rejected. */
export const PayPalDisputeSchema = z.object({
  dispute_id: z.string(),
  update_time: z.string(),
  reason: z.string().optional(),
  status: z.string().min(1),
  dispute_life_cycle_stage: z.string().min(1).optional(),
  seller_response_due_date: z.string().optional(),
  dispute_amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
  dispute_outcome: z
    .object({
      outcome_code: z.string().min(1),
      outcome_reason: z.string().optional(),
      amount_refunded: z.object({ currency_code: z.string(), value: z.string() }).optional(),
    })
    .optional(),
  disputed_transactions: z
    .array(z.object({ seller_transaction_id: z.string().optional(), custom: z.string().optional() }))
    .optional(),
  links: z.array(z.object({ rel: z.string() })).default([]),
});

/** What `disputes.outcome` stores: PayPal's outcome, verbatim. */
export interface DisputeOutcomeRecord {
  readonly outcome_code: string;
  readonly outcome_reason: string | null;
  readonly amount_refunded: { readonly currency_code: string; readonly value: string } | null;
}

export interface DisputeMirror {
  readonly disputeId: DisputeId;
  /** `disputed_transactions[0].seller_transaction_id`: the capture the dispute is about */
  readonly captureId: CaptureId | null;
  /** `disputed_transactions[0].custom`: the capture's `custom_id` (a claim, not proof of owner) */
  readonly customId: string | null;
  readonly reason: string | null;
  readonly state: DisputeMirrorState;
  readonly sellerResponseDueDate: Instant | null;
  /** `dispute_amount` verbatim (M2-08: the amount a seller types to accept a claim); null when absent */
  readonly amount: { readonly currency_code: string; readonly value: string } | null;
  readonly outcome: DisputeOutcomeRecord | null;
  /** sorted, de-duplicated link rels other than `self` */
  readonly allowedActions: readonly string[];
  readonly updateTime: Instant;
}

/** The actions a dispute offers right now: the `rel`s of its current links, `self` excluded, sorted. */
export function allowedActionsFromLinks(links: readonly { readonly rel: string }[]): string[] {
  return [...new Set(links.map((l) => l.rel).filter((rel) => rel !== "self"))].sort();
}

function invalid(message: string, details: Record<string, unknown>): Result<never, DomainError> {
  return err(domainError("invalid_paypal_resource", message, details));
}

/** Maps a dispute body (GET /v1/customer/disputes/{id}) to the mirror. */
export function mapDispute(body: unknown): Result<DisputeMirror, DomainError> {
  const parsed = PayPalDisputeSchema.safeParse(body);
  if (!parsed.success) return invalid("not a PayPal dispute", { issues: parsed.error.issues.length });
  const d = parsed.data;
  const disputeId = DisputeIdSchema.safeParse(d.dispute_id);
  if (!disputeId.success) return invalid("dispute id is malformed", { id: d.dispute_id });
  const updateTime = parseInstant(d.update_time);
  if (!updateTime.ok) return updateTime;
  const due = d.seller_response_due_date === undefined ? null : parseInstant(d.seller_response_due_date);
  if (due !== null && !due.ok) return due;
  const tx = d.disputed_transactions?.[0];
  const captureId = CaptureIdSchema.safeParse(tx?.seller_transaction_id).data ?? null;
  const o = d.dispute_outcome;
  return ok({
    disputeId: disputeId.data,
    captureId,
    customId: tx?.custom ?? null,
    reason: d.reason ?? null,
    state: mapDisputeState({
      status: d.status,
      stage: d.dispute_life_cycle_stage ?? null,
      outcomeCode: o?.outcome_code ?? null,
    }),
    sellerResponseDueDate: due === null ? null : due.value,
    amount:
      d.dispute_amount === undefined
        ? null
        : { currency_code: d.dispute_amount.currency_code, value: d.dispute_amount.value },
    outcome:
      o === undefined
        ? null
        : {
            outcome_code: o.outcome_code,
            outcome_reason: o.outcome_reason ?? null,
            amount_refunded: o.amount_refunded ?? null,
          },
    allowedActions: allowedActionsFromLinks(d.links),
    updateTime: updateTime.value,
  });
}

/** PayPal's `RESOLVED` is the only closed status; anything else (unknown values too) is still open. */
export function isDisputeOpen(state: DisputeMirrorState): boolean {
  return !(state.status.kind === "known" && state.status.value === "RESOLVED");
}
