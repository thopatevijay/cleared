// The holds API contract (M3-01, hold.md): `GET /api/holds` and `GET /api/holds/:id`. PayPal values
// (capture status, reason, dispute status) stay raw strings. Release dates are estimates: the rule id
// says where each one comes from (`rules.ts`), and the client shows that row's source with it.
import { z } from "zod";
import { TrackingSummarySchema } from "../carriers/summary.ts";
import { AmountSchema } from "../contracts/payments.ts";
import { HOLD_TYPES } from "./rules.ts";
import { HOLD_STATES } from "./state.ts";
import { HoldExplanationSchema } from "../ai/explain-hold/schema.ts";

const when = z.iso.datetime({ offset: true });

export const HoldItemSchema = z.object({
  id: z.uuid(),
  paymentId: z.uuid(),
  captureId: z.string().min(1),
  amount: AmountSchema,
  state: z.enum(HOLD_STATES),
  type: z.enum(HOLD_TYPES),
  /** capture `status_details.reason`, verbatim */
  reason: z.string().min(1),
  openedAt: when,
  releasedAt: when.nullable(),
  /** estimated, from rule `ruleId`; null when the source gives no timeline */
  estimatedReleaseAt: when.nullable(),
  /** the later bound the same rule states (payment review: 3 business days), when it does */
  estimateUpperBoundAt: when.nullable(),
  ruleId: z.string().min(1),
  /** M3-03: goods holds only, route advice + where the tracking action stands */
  tracking: TrackingSummarySchema.nullable().optional(),
  /** dispute-linked holds: our dispute row id, PayPal's id, status and reply deadline */
  dispute: z
    .object({
      id: z.uuid(),
      disputeId: z.string().min(1),
      status: z.string().min(1),
      dueDate: when.nullable(),
    })
    .nullable(),
});
export type HoldItem = z.infer<typeof HoldItemSchema>;

export const HoldsResponseSchema = z.object({
  items: z.array(HoldItemSchema),
  summary: z.object({
    /** active derived holds per currency, never summed across currencies (samples never count) */
    held: z.array(AmountSchema),
    count: z.number().int().min(0),
  }),
  workspace: z.object({ timezone: z.string().min(1) }),
});
export type HoldsResponse = z.infer<typeof HoldsResponseSchema>;

export const HoldDetailSchema = z.object({
  hold: HoldItemSchema,
  /** the mirrored capture now (the hold is `released` only once it leaves PENDING) */
  payment: z.object({ id: z.uuid(), status: z.string().min(1), statusReason: z.string().nullable() }),
  workspace: z.object({ timezone: z.string().min(1) }),
  /** M3-02: the newest explanation per locale (at most one `en`, one `hi`); plain text */
  explanations: z.array(HoldExplanationSchema).max(2),
});
export type HoldDetail = z.infer<typeof HoldDetailSchema>;
