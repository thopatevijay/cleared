// PayPal capture -> Payment state. Mirror only: the state is PayPal's `status` plus
// `status_details.reason`, with no state of our own. Unknown values are kept verbatim.
import { z } from "zod";
import { domainError, type DomainError } from "../errors.ts";
import { CaptureIdSchema, OrderIdSchema, type CaptureId, type OrderId } from "../ids.ts";
import { mirrorEnum, type Mirrored } from "../mirror.ts";
import { moneyFromPayPal, PayPalMoneySchema, type Money } from "../money.ts";
import { err, ok, type Result } from "../result.ts";
import { parseInstant, type Instant } from "../time.ts";

/**
 * PayPal v2 capture `status` values (Payments v2 "capture" object), plus `REVERSED`, which the Payment
 * state diagram (docs/architecture.md §2) carries for PAYMENT.CAPTURE.REVERSED.
 */
export const CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
  "REVERSED",
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** PayPal v2 capture `status_details.reason` values for a PENDING capture. */
export const PENDING_REASONS = [
  "BUYER_COMPLAINT",
  "CHARGEBACK",
  "ECHECK",
  "INTERNATIONAL_WITHDRAWAL",
  "OTHER",
  "PENDING_REVIEW",
  "RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION",
  "REFUNDED",
  "TRANSACTION_APPROVED_AWAITING_FUNDING",
  "UNILATERAL",
  "VERIFICATION_REQUIRED",
] as const;
export type PendingReason = (typeof PENDING_REASONS)[number];

export interface PaymentState {
  readonly status: Mirrored<CaptureStatus>;
  /** `status_details.reason` verbatim; null when PayPal sends none */
  readonly reason: Mirrored<PendingReason> | null;
}

/** The fields of a PayPal capture body Cleared reads. Everything else is ignored, never rejected. */
export const PayPalCaptureSchema = z.object({
  id: z.string(),
  status: z.string().min(1),
  status_details: z.object({ reason: z.string().min(1).optional() }).optional(),
  amount: PayPalMoneySchema,
  custom_id: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  seller_receivable_breakdown: z.object({ net_amount: PayPalMoneySchema.optional() }).optional(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().optional() }).optional() }).optional(),
});
export type PayPalCapture = z.infer<typeof PayPalCaptureSchema>;

export interface CaptureMirror {
  readonly captureId: CaptureId;
  readonly orderId: OrderId | null;
  readonly customId: string | null;
  readonly amount: Money;
  /** seller_receivable_breakdown.net_amount, when PayPal sends it */
  readonly receivable: Money | null;
  readonly state: PaymentState;
  /** update_time, else create_time; null only when PayPal sends neither */
  readonly updateTime: Instant | null;
}

export function mapPaymentState(status: string, reason: string | null): PaymentState {
  return {
    status: mirrorEnum(CAPTURE_STATUSES, status),
    reason: reason === null ? null : mirrorEnum(PENDING_REASONS, reason),
  };
}

/** A hold is a capture in PENDING with a reason (CLAUDE.md domain rules). M3-01 extends the rule table. */
export function isHold(state: PaymentState): boolean {
  return state.status.kind === "known" && state.status.value === "PENDING" && state.reason !== null;
}

function invalid(message: string, details: Record<string, unknown>): Result<never, DomainError> {
  return err(domainError("invalid_paypal_resource", message, details));
}

/** Maps a capture body (GET /v2/payments/captures/{id}, or one in an order's purchase_units). */
export function mapCapture(body: unknown): Result<CaptureMirror, DomainError> {
  const parsed = PayPalCaptureSchema.safeParse(body);
  if (!parsed.success) return invalid("not a PayPal capture", { issues: parsed.error.issues.length });
  const c = parsed.data;
  const captureId = CaptureIdSchema.safeParse(c.id);
  if (!captureId.success) return invalid("capture id is malformed", { id: c.id });
  const rawOrderId = c.supplementary_data?.related_ids?.order_id;
  const orderId = rawOrderId === undefined ? null : OrderIdSchema.safeParse(rawOrderId).data ?? null;
  const amount = moneyFromPayPal(c.amount);
  if (!amount.ok) return amount;
  const net = c.seller_receivable_breakdown?.net_amount;
  const receivable = net === undefined ? null : moneyFromPayPal(net);
  if (receivable !== null && !receivable.ok) return receivable;
  const rawTime = c.update_time ?? c.create_time;
  const updateTime = rawTime === undefined ? null : parseInstant(rawTime);
  if (updateTime !== null && !updateTime.ok) return updateTime;
  return ok({
    captureId: captureId.data,
    orderId,
    customId: c.custom_id ?? null,
    amount: amount.value,
    receivable: receivable === null ? null : receivable.value,
    state: mapPaymentState(c.status, c.status_details?.reason ?? null),
    updateTime: updateTime === null ? null : updateTime.value,
  });
}
