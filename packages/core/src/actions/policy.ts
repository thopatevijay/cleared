// Action policy in code (ADR 0010: "a few policies, all in code"):
// - `checkApproval`: what a seller approval must satisfy (hash bound to the stored payload, a known
//   executable kind with a valid payload, and for `accept_claim` a seller-created action plus the exact
//   typed confirmation of the dispute amount).
// - `canExecute`: the M1-01 last gate before a PayPal write. The worker's ordered checks are in checks.ts.
import { z } from "zod";
import { Sha256Schema, type Sha256 } from "../ids.ts";
import { addMinutes, compareInstants, type Instant } from "../time.ts";
import type { Approval, ProposedAction } from "./action.ts";
import type { ActionState } from "./state.ts";

// ---- executable payloads ------------------------------------------------------------------------

const DisputeRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
const Notes = z.string().min(1).max(2000);

const provideEvidenceShape = {
  dispute_id: DisputeRef,
  evidence_type: z.string().regex(/^[A-Z_]{1,64}$/),
  notes: Notes,
  compiled_blob_sha256: Sha256Schema,
  draft_id: z.uuid(),
};
const provideSupportingInfoShape = {
  dispute_id: DisputeRef,
  notes: Notes,
  compiled_blob_sha256: Sha256Schema.optional(),
  draft_id: z.uuid().optional(),
};
const blobFieldsTogether = (p: {
  compiled_blob_sha256?: string | undefined;
  draft_id?: string | undefined;
}): boolean => (p.compiled_blob_sha256 === undefined) === (p.draft_id === undefined);
const BLOB_FIELDS_MESSAGE = { message: "compiled_blob_sha256 and draft_id go together" };

/** M2-07's filing payload: notes plus one compiled PDF, both bound by the approval hash. */
export const ProvideEvidencePayloadSchema = z.object(provideEvidenceShape);

/** Supporting info: notes, optionally with the compiled PDF (both blob fields, or neither). */
export const ProvideSupportingInfoPayloadSchema = z
  .object(provideSupportingInfoShape)
  .refine(blobFieldsTogether, BLOB_FIELDS_MESSAGE);

/**
 * The same two filing payloads, strict (unknown keys refused). The agent's proposal guardrail (M2-02) uses
 * them, so a proposal that passes the guardrail also passes `checkApproval` (BL-01 6537330886, M2-07).
 */
export const STRICT_FILING_PAYLOAD_SCHEMAS = {
  provide_evidence: z.strictObject(provideEvidenceShape),
  provide_supporting_info: z
    .strictObject(provideSupportingInfoShape)
    .refine(blobFieldsTogether, BLOB_FIELDS_MESSAGE),
} as const;

/** Seller-created only. `amount` is the dispute amount the seller confirms by typing it. */
export const AcceptClaimPayloadSchema = z.object({
  dispute_id: DisputeRef,
  note: Notes,
  amount: z.object({
    value: z.string().regex(/^\d{1,15}(\.\d{1,3})?$/),
    currency_code: z.string().regex(/^[A-Z]{3}$/),
  }),
  accept_claim_type: z.literal("REFUND"),
});

const PayPalId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/**
 * M3-03: one tracker on one capture (Orders v2 `POST /v2/checkout/orders/{order_id}/track`). `carrier` is a
 * PayPal code, or `OTHER` with `carrier_name_other` (≤ 64); `notify_payer` is always false. Unknown keys
 * are refused: the approval hash binds every field.
 */
export const AddTrackingPayloadSchema = z
  .strictObject({
    order_id: PayPalId,
    capture_id: PayPalId,
    carrier: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    carrier_name_other: z.string().trim().min(1).max(64).optional(),
    tracking_number: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/),
    notify_payer: z.literal(false),
  })
  .refine((p) => (p.carrier === "OTHER") === (p.carrier_name_other !== undefined), {
    message: "carrier_name_other goes with carrier OTHER, and only with it",
  });
export type AddTrackingPayload = z.infer<typeof AddTrackingPayloadSchema>;

/** The kinds the worker executes (M2-08; `add_tracking` M3-03). Completed (M3-04) joins here later. */
export const EXECUTABLE_PAYLOAD_SCHEMAS = {
  provide_evidence: ProvideEvidencePayloadSchema,
  provide_supporting_info: ProvideSupportingInfoPayloadSchema,
  accept_claim: AcceptClaimPayloadSchema,
  add_tracking: AddTrackingPayloadSchema,
} as const;
export type ExecutableKind = keyof typeof EXECUTABLE_PAYLOAD_SCHEMAS;
export const EXECUTABLE_KINDS = Object.keys(EXECUTABLE_PAYLOAD_SCHEMAS) as ExecutableKind[];

export type ExecutablePayload =
  | { readonly kind: "provide_evidence"; readonly payload: z.infer<typeof ProvideEvidencePayloadSchema> }
  | {
      readonly kind: "provide_supporting_info";
      readonly payload: z.infer<typeof ProvideSupportingInfoPayloadSchema>;
    }
  | { readonly kind: "accept_claim"; readonly payload: z.infer<typeof AcceptClaimPayloadSchema> }
  | { readonly kind: "add_tracking"; readonly payload: AddTrackingPayload };

/** The executable payloads that act on a dispute (all but `add_tracking`). */
export type DisputeExecutablePayload = Exclude<ExecutablePayload, { readonly kind: "add_tracking" }>;

export function isExecutableKind(kind: string): kind is ExecutableKind {
  return Object.hasOwn(EXECUTABLE_PAYLOAD_SCHEMAS, kind);
}

/** The payload as the executor reads it; null when the kind is not executable or the payload is invalid. */
export function parseExecutablePayload(kind: string, payload: unknown): ExecutablePayload | null {
  if (!isExecutableKind(kind)) return null;
  const parsed = EXECUTABLE_PAYLOAD_SCHEMAS[kind].safeParse(payload);
  if (!parsed.success) return null;
  return { kind, payload: parsed.data } as ExecutablePayload;
}

/** What the seller types to accept a claim: the dispute amount as displayed, e.g. `120.00 USD`. */
export function typedConfirmationFor(amount: {
  readonly value: string;
  readonly currency_code: string;
}): string {
  return `${amount.value} ${amount.currency_code}`;
}

// ---- approval ----------------------------------------------------------------------------------

export const APPROVAL_REFUSALS = [
  "ACTION_NOT_PROPOSED",
  "APPROVAL_HASH_MISMATCH",
  "UNKNOWN_ACTION_KIND",
  "INVALID_PAYLOAD",
  "AGENT_ACCEPT_CLAIM_FORBIDDEN",
  "TYPED_CONFIRMATION_REQUIRED",
  "TYPED_CONFIRMATION_MISMATCH",
] as const;
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number];

export interface ApprovalSubject {
  readonly kind: string;
  readonly state: ActionState;
  readonly payload: unknown;
  readonly payloadSha256: string;
  readonly createdByRunId: string | null;
}

export interface ApprovalInput {
  /** the hash the seller saw and approved */
  readonly payloadSha256: string;
  readonly typedConfirmation?: string | undefined;
}

export type ApprovalDecision =
  | { readonly kind: "allow"; readonly executable: ExecutablePayload }
  | { readonly kind: "refuse"; readonly code: ApprovalRefusal };

/** Approval policy, in this order: state, hash, kind, payload, then the `accept_claim` rules. */
export function checkApproval(action: ApprovalSubject, input: ApprovalInput): ApprovalDecision {
  const refuse = (code: ApprovalRefusal): ApprovalDecision => ({ kind: "refuse", code });
  if (action.state !== "proposed") return refuse("ACTION_NOT_PROPOSED");
  if (input.payloadSha256 !== action.payloadSha256) return refuse("APPROVAL_HASH_MISMATCH");
  if (!isExecutableKind(action.kind)) return refuse("UNKNOWN_ACTION_KIND");
  const executable = parseExecutablePayload(action.kind, action.payload);
  if (executable === null) return refuse("INVALID_PAYLOAD");
  if (executable.kind === "accept_claim") {
    if (action.createdByRunId !== null) return refuse("AGENT_ACCEPT_CLAIM_FORBIDDEN");
    if (input.typedConfirmation === undefined || input.typedConfirmation === "") {
      return refuse("TYPED_CONFIRMATION_REQUIRED");
    }
    if (input.typedConfirmation !== typedConfirmationFor(executable.payload.amount)) {
      return refuse("TYPED_CONFIRMATION_MISMATCH");
    }
  }
  return { kind: "allow", executable };
}

// ---- canExecute (M1-01) ------------------------------------------------------------------------
// The last gate before a PayPal write (ADR 0010). Pure; the caller supplies a fresh re-fetch
// (hasActionLink, dueDate), the hash of the payload about to be sent, and the kill switch.

/** No action runs at or after `seller_response_due_date − 1 h`. */
export const DEADLINE_MARGIN_MINUTES = 60;

export const REFUSAL_REASONS = [
  "kill_switch_on",
  "not_approved",
  "no_approval",
  "hash_mismatch",
  "past_deadline",
  "no_action_link",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface ExecutionContext {
  readonly now: Instant;
  /** the dispute's seller_response_due_date from the fresh re-fetch; null when the action has no deadline */
  readonly dueDate: Instant | null;
  /** the matching HATEOAS link is in the freshly fetched resource */
  readonly hasActionLink: boolean;
  readonly approval: Approval | null;
  /** sha256 of canonicalJson(payload) computed now, from the exact payload about to be sent */
  readonly payloadSha256: Sha256;
  readonly killSwitch: boolean;
}

export type ExecutionDecision =
  { readonly kind: "allow" } | { readonly kind: "refuse"; readonly reason: RefusalReason };

function refuse(reason: RefusalReason): ExecutionDecision {
  return { kind: "refuse", reason };
}

export function canExecute(action: ProposedAction, ctx: ExecutionContext): ExecutionDecision {
  if (ctx.killSwitch) return refuse("kill_switch_on");
  if (action.state !== "approved") return refuse("not_approved");
  if (ctx.approval?.actionId !== action.id) return refuse("no_approval");
  if (ctx.approval.payloadSha256 !== action.payloadSha256 || ctx.payloadSha256 !== action.payloadSha256) {
    return refuse("hash_mismatch");
  }
  if (ctx.dueDate !== null) {
    const cutoff = addMinutes(ctx.dueDate, -DEADLINE_MARGIN_MINUTES);
    if (compareInstants(ctx.now, cutoff) >= 0) return refuse("past_deadline");
  }
  if (!ctx.hasActionLink) return refuse("no_action_link");
  return { kind: "allow" };
}
