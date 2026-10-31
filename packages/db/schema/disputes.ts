// Disputes mirror PayPal (status/stage as text) plus the HATEOAS links that gate every action.
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { agentRuns } from "./agent.ts";
import { currency, money, sha256, tstz } from "./columns.ts";
import { actionKind, deadlineState, draftState } from "./enums.ts";
import { payments } from "./payments.ts";
import { blobs, proofPacks } from "./proof.ts";

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
    /** M2-08: PayPal's `dispute_amount` (what a seller types to accept a claim); null until synced */
    amount: money("amount"),
    currency: currency("currency"),
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
    /** M2-07: canonicalHash of the filing payload the draft's proposal carries */
    sha256: sha256("sha256"),
    // M2-07: what the agent drafted from; null on rows written before M2-07 (test stand-ins)
    packId: uuid("pack_id").references(() => proofPacks.id),
    /** the pack's scope check version (M2-04) the draft read */
    checkVersion: integer("check_version"),
    /** the filing action proposed, chosen from the dispute's links */
    actionKind: actionKind("action_kind"),
    evidenceType: text("evidence_type"),
    reasonUnmapped: boolean("reason_unmapped").notNull().default(false),
    /** `[{paragraph, refs: [{ref, kind, evidence_item_id|null}]}]`: what each paragraph relies on */
    factRefs: jsonb("fact_refs").notNull().default([]),
    runId: uuid("run_id").references(() => agentRuns.id),
    proposedActionId: uuid("proposed_action_id"),
  },
  (t) => [
    // M2-07: one draft per (dispute, pack check version, filing action); a re-delivered trigger finds it
    uniqueIndex("dispute_drafts_idempotency_key").on(t.disputeId, t.checkVersion, t.actionKind),
    check("dispute_drafts_notes_length", sql`char_length(${t.notes}) <= 2000`),
    index("dispute_drafts_dispute_idx").on(t.disputeId),
    index("dispute_drafts_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
