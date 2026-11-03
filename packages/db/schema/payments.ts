// Payments mirror the PayPal capture; holds are derived from its status (CLAUDE.md: hold = PENDING +
// status_details.reason). PayPal values are text so an unknown value is kept verbatim.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { currency, money, tstz } from "./columns.ts";
import { holdState, locale, syncSource } from "./enums.ts";

export const payments = pgTable(
  "payments",
  {
    ...scoped(),
    captureId: text("capture_id").notNull(),
    orderId: text("order_id"),
    amount: money("amount").notNull(),
    currency: currency("currency").notNull(),
    receivableAmount: money("receivable_amount"),
    receivableCurrency: currency("receivable_currency"),
    status: text("status").notNull(),
    statusReason: text("status_reason"),
    source: syncSource("source").notNull(),
    /** PayPal `update_time ?? create_time`; `applyMirror` refuses strictly older updates */
    paypalUpdatedAt: tstz("paypal_updated_at"),
    syncedAt: tstz("synced_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_capture_id_key").on(t.captureId),
    index("payments_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const holds = pgTable(
  "holds",
  {
    ...scoped(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    state: holdState("state").notNull().default("open"),
    type: text("type").notNull(),
    reason: text("reason").notNull(),
    openedAt: tstz("opened_at").notNull(),
    releasedAt: tstz("released_at"),
    /** an estimate, always with its cited source */
    estimatedReleaseAt: tstz("estimated_release_at"),
    estimateSource: text("estimate_source"),
    /** M3-04: when the seller says they marked the service order Completed in PayPal (the web step) */
    completedConfirmedAt: tstz("completed_confirmed_at"),
    /**
     * BL-01 6570499264 (ADR 0017 addendum 3): what the seller says they sold, "goods" | "service". Cleared's
     * own field, never a PayPal state: it picks the guided action and never the hold's type or estimate.
     */
    sellerDeclaredKind: text("seller_declared_kind"),
    /** who declared it (the session actor) and when */
    sellerDeclaredBy: text("seller_declared_by"),
    sellerDeclaredAt: tstz("seller_declared_at"),
  },
  (t) => [
    check(
      "holds_seller_declared_kind",
      sql`${t.sellerDeclaredKind} is null or ${t.sellerDeclaredKind} in ('goods', 'service')`,
    ),
    check(
      "holds_seller_declared_complete",
      sql`(${t.sellerDeclaredKind} is null) = (${t.sellerDeclaredBy} is null) and (${t.sellerDeclaredKind} is null) = (${t.sellerDeclaredAt} is null)`,
    ),
    index("holds_payment_idx").on(t.paymentId),
    index("holds_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const explanations = pgTable(
  "explanations",
  {
    ...scoped(),
    holdId: uuid("hold_id")
      .notNull()
      .references(() => holds.id),
    locale: locale("locale").notNull(),
    text: text("text").notNull(),
    sourceRef: text("source_ref").notNull(),
  },
  (t) => [
    index("explanations_hold_idx").on(t.holdId),
    index("explanations_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
