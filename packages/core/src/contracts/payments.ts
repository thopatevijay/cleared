// The payments list contract (ADR 0003, M1-07): `GET /api/payments?offset&limit` and
// `POST /api/sandbox/test-payments`. PayPal values (status, reason, currency) stay raw strings: the
// list mirrors PayPal and never rejects a value PayPal adds later.
import { z } from "zod";
import { SYNC_SOURCES } from "../payments/payment.ts";

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
});
export type PaymentItem = z.infer<typeof PaymentItemSchema>;

export const PaymentsResponseSchema = z.object({
  items: z.array(PaymentItemSchema),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(PAYMENTS_PAGE_MAX),
  summary: z.object({
    /** Sum of mirrored PENDING captures, one entry per currency (never summed across currencies) */
    held: z.array(AmountSchema),
    /** null until dispute support (M2-09) */
    inDispute: z.null(),
    /** null until proof packs (M2-05) */
    proofReady: z.null(),
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
