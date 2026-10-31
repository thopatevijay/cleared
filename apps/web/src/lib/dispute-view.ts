// M2-09: the dispute and audit read APIs' response shapes, shared by the server handlers (which build
// them) and the client screens (which parse them). PayPal's statuses, reasons and outcomes are strings
// verbatim: nothing here maps them to states of our own.
import { AmountSchema, DEADLINE_STATES } from "@cleared/core";
import { z } from "zod";

export const NOTES_MAX = 2000;
/** The count is announced at this many characters and above the limit, never on every keystroke. */
export const NOTES_WARN_AT = 1900;

const Iso = z.string();

export const OutcomeSchema = z.object({ outcome_code: z.string(), outcome_reason: z.string().nullable() });
export type Outcome = z.infer<typeof OutcomeSchema>;

export const LinkedPaymentSchema = z.object({
  id: z.uuid(),
  captureId: z.string(),
  amount: AmountSchema,
  status: z.string(),
  statusReason: z.string().nullable(),
});

export const DisputeSummarySchema = z.object({
  id: z.uuid(),
  disputeId: z.string(),
  status: z.string(),
  stage: z.string().nullable(),
  reason: z.string().nullable(),
  amount: AmountSchema.nullable(),
  dueDate: Iso.nullable(),
  deadlineState: z.enum(DEADLINE_STATES),
  outcome: OutcomeSchema.nullable(),
  payment: LinkedPaymentSchema.nullable(),
  /** a draft reply waits for the seller's review (its proposal is `proposed` and PayPal allows it) */
  draftReady: z.boolean(),
});
export type DisputeSummary = z.infer<typeof DisputeSummarySchema>;

export const DisputeListSchema = z.object({
  items: z.array(DisputeSummarySchema),
  /** open disputes' amounts, one total per currency (never summed across currencies) */
  summary: z.object({ inDispute: z.array(AmountSchema) }),
  workspace: z.object({ timezone: z.string() }),
});
export type DisputeList = z.infer<typeof DisputeListSchema>;

export const ActionViewSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  state: z.string(),
  risk: z.string(),
  createdBy: z.enum(["agent", "seller"]),
  payload: z.unknown(),
  payload_sha256: z.string(),
  refusal: z.string().nullable(),
  typedConfirmation: z.string().nullable(),
  approval: z.object({ approvedAt: Iso }).nullable(),
  execution: z
    .object({ paypalStatus: z.string().nullable(), paypalDebugId: z.string().nullable() })
    .nullable(),
});
export type ActionViewData = z.infer<typeof ActionViewSchema>;

export const DraftItemSchema = z.object({
  id: z.uuid(),
  /** E1, E2… in the pack's order (oldest first), as the compiled PDF labels them */
  ref: z.string(),
  kind: z.string(),
  mime: z.string().nullable(),
  size: z.number().nullable(),
  addedAt: Iso,
  selected: z.boolean(),
  /** the item's file (an evidence item without a file has text only) */
  fileUrl: z.string().nullable(),
  /** the item in its proof pack (M2-05's pack page), the citation link */
  packUrl: z.string().nullable(),
});
export type DraftItem = z.infer<typeof DraftItemSchema>;

export const DraftSchema = z.object({
  id: z.uuid(),
  actionKind: z.enum(["provide_evidence", "provide_supporting_info"]),
  evidenceType: z.string().nullable(),
  reasonUnmapped: z.boolean(),
  /** model output (or the seller's edit): rendered as plain text only */
  notes: z.string(),
  items: z.array(DraftItemSchema),
  pdf: z.object({ url: z.string(), bytes: z.number() }).nullable(),
  /** the filing proposal this draft is bound to (null on rows written before M2-07) */
  action: ActionViewSchema.nullable(),
  /** PayPal still offers this draft's action in the dispute's current links */
  allowed: z.boolean(),
});
export type Draft = z.infer<typeof DraftSchema>;

export const AuditEntrySchema = z.object({
  id: z.uuid(),
  at: Iso,
  actor: z.enum(["seller", "agent", "system"]),
  /** `detail.sandbox_decision = true` (M2-10): shown as the "Sandbox decision" actor */
  sandbox: z.boolean(),
  action: z.string(),
  /** allow-listed scalar detail fields only (never notes, evidence text or buyer messages) */
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  refs: z.object({
    disputeId: z.string().nullable(),
    debugId: z.string().nullable(),
    fingerprint: z.string().nullable(),
    actionId: z.string().nullable(),
  }),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  next: z.string().nullable(),
  workspace: z.object({ timezone: z.string() }),
});
export type AuditPageData = z.infer<typeof AuditPageSchema>;

export const DisputeDetailSchema = z.object({
  dispute: DisputeSummarySchema.extend({
    allowedActions: z.array(z.string()),
    paypalUpdatedAt: Iso.nullable(),
  }),
  draft: DraftSchema.nullable(),
  /** why no draft exists: `dispute_draft.unavailable` / `too_late` (code only) */
  draftOutcome: z
    .object({ kind: z.enum(["unavailable", "too_late"]), code: z.string().nullable() })
    .nullable(),
  /** the pack's items when no draft exists ("draft unavailable": the seller can still download them) */
  packItems: z.array(DraftItemSchema),
  acceptClaim: ActionViewSchema.nullable(),
  killSwitch: z.boolean(),
  scenarioId: z.uuid().nullable(),
  audit: z.array(AuditEntrySchema),
  workspace: z.object({ timezone: z.string() }),
});
export type DisputeDetail = z.infer<typeof DisputeDetailSchema>;

/** The draft fingerprint: the first 8 hex characters of `payload_sha256`. */
export const fingerprint = (sha: string): string => sha.slice(0, 8);

/** Unicode code points, as PayPal counts the 2000-character notes limit. */
export function codePointCount(s: string): number {
  return Array.from(s).length;
}

/** RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL: "you keep the money (PayPal covered the case)". */
export function isPaypalCoveredPayout(o: Outcome | null): boolean {
  return o?.outcome_code === "RESOLVED_WITH_PAYOUT" && o.outcome_reason === "REPRESENTED_BY_PAYPAL";
}
