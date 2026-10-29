// zod schemas for every PayPal response field Cleared reads (Orders v2, Payments v2 captures,
// Orders v2 tracking, legacy /v1/shipping trackers, OAuth, errors). Statuses mirror PayPal's
// documented enums; unknown extra fields are stripped, never invented.
import { z } from "zod";

export const MoneySchema = z.object({
  currency_code: z.string().length(3),
  value: z.string(),
});
export type Money = z.infer<typeof MoneySchema>;

export const LinkSchema = z.object({
  href: z.string(),
  rel: z.string(),
  method: z.string().optional(),
});

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  app_id: z.string().optional(),
});

export const SellerReceivableBreakdownSchema = z.object({
  gross_amount: MoneySchema,
  paypal_fee: MoneySchema.optional(),
  net_amount: MoneySchema.optional(),
  receivable_amount: MoneySchema.optional(),
  exchange_rate: z.object({ value: z.string().optional() }).optional(),
});

// https://developer.paypal.com/docs/api/payments/v2/#captures_get
export const CaptureStatusSchema = z.enum([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);

export const CaptureSchema = z.object({
  id: z.string(),
  status: CaptureStatusSchema,
  status_details: z.object({ reason: z.string() }).optional(),
  amount: MoneySchema,
  final_capture: z.boolean().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  seller_protection: z
    .object({ status: z.string(), dispute_categories: z.array(z.string()).optional() })
    .optional(),
  seller_receivable_breakdown: SellerReceivableBreakdownSchema.optional(),
  supplementary_data: z
    .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
    .optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const OrderTrackerSchema = z.object({
  id: z.string(),
  status: z.string(),
  notify_payer: z.boolean().optional(),
  links: z.array(LinkSchema).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});
export type OrderTracker = z.infer<typeof OrderTrackerSchema>;

export const PurchaseUnitSchema = z.object({
  reference_id: z.string().optional(),
  custom_id: z.string().optional(),
  amount: MoneySchema.optional(),
  payments: z.object({ captures: z.array(CaptureSchema).optional() }).optional(),
  shipping: z.object({ trackers: z.array(OrderTrackerSchema).optional() }).optional(),
});

// https://developer.paypal.com/docs/api/orders/v2/#orders_get
export const OrderStatusSchema = z.enum([
  "CREATED",
  "SAVED",
  "APPROVED",
  "VOIDED",
  "COMPLETED",
  "PAYER_ACTION_REQUIRED",
]);

export const OrderSchema = z.object({
  id: z.string(),
  status: OrderStatusSchema,
  intent: z.string().optional(),
  purchase_units: z.array(PurchaseUnitSchema).default([]),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type Order = z.infer<typeof OrderSchema>;

// Legacy /v1/shipping (Add Tracking API): the only route to `COMPLETED` with no tracking number.
export const TrackersBatchResponseSchema = z.object({
  tracker_identifiers: z.array(
    z.object({
      transaction_id: z.string(),
      tracking_number: z.string().optional(),
      links: z.array(LinkSchema).optional(),
    }),
  ),
  errors: z.array(z.object({ name: z.string().optional(), message: z.string().optional() }).loose()),
  links: z.array(LinkSchema).optional(),
});
export type TrackersBatchResponse = z.infer<typeof TrackersBatchResponseSchema>;

export const LegacyTrackerSchema = z.object({
  transaction_id: z.string(),
  tracking_number: z.string().optional(),
  status: z.string(),
  carrier: z.string().optional(),
  shipment_direction: z.string().optional(),
  shipment_uploader: z.string().optional(),
  links: z.array(LinkSchema).optional(),
});
export type LegacyTracker = z.infer<typeof LegacyTrackerSchema>;

export const PayPalErrorBodySchema = z.object({
  name: z.string(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z
    .array(
      z.object({
        field: z.string().optional(),
        value: z.string().optional(),
        location: z.string().optional(),
        issue: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
});
export type PayPalErrorBody = z.infer<typeof PayPalErrorBodySchema>;

/** OAuth endpoints answer errors in RFC 6749 shape instead. */
export const OAuthErrorBodySchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
