// The payments list contract (ADR 0003, M1-07): `GET /api/payments?offset&limit` and
// `POST /api/sandbox/test-payments`. PayPal values (status, reason, currency) stay raw strings: the
// list mirrors PayPal and never rejects a value PayPal adds later.
import { z } from "zod";
import { SYNC_SOURCES } from "../payments/payment.ts";
import { VERDICTS } from "../proof/pack.ts";
import { PACK_VIEW_STATES } from "../proof/pack-view.ts";

/** Offset pagination; at most 50 rows per page. */
export const PAYMENTS_PAGE_MAX = 50;
/** Sandbox test payments a workspace may request per rolling 24 h. */
export const TEST_PAYMENTS_PER_DAY = 3;

const intParam = (min: number, max: number, fallback: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined || v === "" ? fallback : Number(v)),
    z.number().int().min(min).max(max),
  );

export const PaymentsQuerySchema = z.object({
  offset: intParam(0, 1_000_000, 0),
  limit: intParam(1, PAYMENTS_PAGE_MAX, PAYMENTS_PAGE_MAX),
});
export type PaymentsQuery = z.infer<typeof PaymentsQuerySchema>;

/** An amount as stored: canonical decimal string + ISO 4217 code (as PayPal sent it). */
export const AmountSchema = z.object({
  value: z.string().regex(/^-?\d+(\.\d+)?$/),
  currency: z.string().length(3),
});
export type Amount = z.infer<typeof AmountSchema>;

/** The payment's proof pack as the dashboard row shows it (M2-05, dashboard.md elements 6 and 16). */
export const PaymentPackSchema = z.object({
  id: z.uuid(),
  view: z.enum(PACK_VIEW_STATES),
  /** the pack holds at least one evidence item ("Add proof" shows only while it does not) */
  hasEvidence: z.boolean(),
  /** checked (or marked ready) with no `missing` line in its latest check */
  proofReady: z.boolean(),
  /** the latest check in one line; null before the first check */
  summary: z
    .object({
      scope: z.enum(VERDICTS),
      delivery: z.enum(VERDICTS),
      sources: z.number().int().min(0),
    })
    .nullable(),
});
export type PaymentPack = z.infer<typeof PaymentPackSchema>;

/** M3-01: the payment's active hold as the dashboard row shows it (dashboard.md elements 7–10). */
export const PaymentHoldSchema = z.object({
  id: z.uuid(),
  /** a `HOLD_TYPES` value */
  type: z.string().min(1),
  /** capture `status_details.reason`, verbatim */
  reason: z.string().min(1),
  /** the rule row (`holdRule(id)`) the estimate and its source come from */
  ruleId: z.string().min(1),
  estimatedReleaseAt: z.iso.datetime({ offset: true }).nullable(),
  estimateUpperBoundAt: z.iso.datetime({ offset: true }).nullable(),
});
export type PaymentHold = z.infer<typeof PaymentHoldSchema>;

export const PaymentItemSchema = z.object({
  id: z.uuid(),
  captureId: z.string().min(1),
  amount: AmountSchema,
  /** PayPal's `seller_receivable_breakdown.receivable_amount`, when it reported one */
  receivable: AmountSchema.nullable(),
  /** capture `status`, verbatim */
  status: z.string().min(1),
  /** capture `status_details.reason`, verbatim (PENDING only) */
  statusReason: z.string().nullable(),
  source: z.enum(SYNC_SOURCES),
  /** PayPal's update time (else when Cleared stored it), ISO 8601 */
  updatedAt: z.iso.datetime({ offset: true }),
  /** null only for a payment stored before packs were created with it (migration 0010 backfills them) */
  pack: PaymentPackSchema.nullable(),
  /** M3-01: the active derived hold; null when PayPal holds nothing on this capture */
  hold: PaymentHoldSchema.nullable(),
});
export type PaymentItem = z.infer<typeof PaymentItemSchema>;

export const PaymentsResponseSchema = z.object({
  items: z.array(PaymentItemSchema),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(PAYMENTS_PAGE_MAX),
  summary: z.object({
    /** M3-01: sum of active derived holds, one entry per currency (never summed across currencies) */
    held: z.array(AmountSchema),
    /** null until dispute support (M2-09) */
    inDispute: z.null(),
    /** packs checked with no `missing` verdict in their latest check (M2-05, dashboard.md 3c) */
    proofReady: z.number().int().min(0),
  }),
  workspace: z.object({ kind: z.enum(["seller", "demo"]), timezone: z.string().min(1) }),
  testPayments: z.object({
    /** requested in the last 15 min and not yet arrived through the webhook */
    waiting: z.number().int().min(0),
    usedToday: z.number().int().min(0),
    limit: z.number().int().min(1),
  }),
});
export type PaymentsResponse = z.infer<typeof PaymentsResponseSchema>;

export const TestPaymentQueuedSchema = z.object({ status: z.literal("queued"), messageId: z.uuid() });
export type TestPaymentQueued = z.infer<typeof TestPaymentQueuedSchema>;
