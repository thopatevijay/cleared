// Disputes mirror PayPal (status/stage as text) plus the HATEOAS links that gate every action.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { sha256, tstz } from "./columns.ts";
import { deadlineState, draftState } from "./enums.ts";
import { payments } from "./payments.ts";
import { blobs } from "./proof.ts";

export const disputes = pgTable(
  "disputes",
  {
    ...scoped(),
    disputeId: text("dispute_id").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id),
    reason: text("reason"),
    stage: text("stage"),
    status: text("status").notNull(),
    sellerResponseDueDate: tstz("seller_response_due_date"),
    /** `{ outcome_code, ... }` once resolved */
    outcome: jsonb("outcome"),
    /** link rels from the dispute's current `links[]` */
    allowedActions: jsonb("allowed_actions").notNull().default([]),
    paypalUpdatedAt: tstz("paypal_updated_at"),
    syncedAt: tstz("synced_at").notNull().defaultNow(),
    /** M2-06: position against `seller_response_due_date` (deadline watcher; core `deadlineState`) */
    deadlineState: deadlineState("deadline_state").notNull().default("ok"),
  },
  (t) => [
    uniqueIndex("disputes_dispute_id_key").on(t.disputeId),
    index("disputes_payment_idx").on(t.paymentId),
    index("disputes_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const disputeDrafts = pgTable(
  "dispute_drafts",
  {
    ...scoped(),
    disputeId: uuid("dispute_id")
      .notNull()
      .references(() => disputes.id),
    state: draftState("state").notNull().default("draft_ready"),
    notes: text("notes").notNull(),
    evidenceItemIds: uuid("evidence_item_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    compiledBlobId: uuid("compiled_blob_id").references(() => blobs.id),
    sha256: sha256("sha256"),
  },
  (t) => [
    check("dispute_drafts_notes_length", sql`char_length(${t.notes}) <= 2000`),
    index("dispute_drafts_dispute_idx").on(t.disputeId),
    index("dispute_drafts_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
