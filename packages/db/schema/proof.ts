// Proof packs (1:1 with a payment), content-addressed blobs and immutable evidence items.
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scoped } from "./accounts.ts";
import { agentRuns } from "./agent.ts";
import { bytea, sha256, tstz } from "./columns.ts";
import { evidenceKind, packState, verdict } from "./enums.ts";
import { payments } from "./payments.ts";

export const proofPacks = pgTable(
  "proof_packs",
  {
    ...scoped(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    state: packState("state").notNull().default("empty"),
    checkedAt: tstz("checked_at"),
  },
  (t) => [
    uniqueIndex("proof_packs_payment_id_key").on(t.paymentId),
    index("proof_packs_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/** BlobStore adapter on Postgres (ADR 0002); move to S3 above 5 GB. */
export const blobs = pgTable(
  "blobs",
  {
    ...scoped(),
    mime: text("mime").notNull(),
    bytes: bytea("bytes").notNull(),
    size: integer("size").notNull(),
    sha256: sha256("sha256").notNull(),
  },
  (t) => [
    index("blobs_sha256_idx").on(t.workspaceId, t.sha256),
    index("blobs_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/** Immutable: a trigger raises on UPDATE/DELETE (migration 0002). */
export const evidenceItems = pgTable(
  "evidence_items",
  {
    ...scoped(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => proofPacks.id),
    kind: evidenceKind("kind").notNull(),
    blobId: uuid("blob_id").references(() => blobs.id),
    sha256: sha256("sha256").notNull(),
    text: text("text"),
  },
  (t) => [
    index("evidence_items_pack_idx").on(t.packId),
    index("evidence_items_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const extractedFacts = pgTable(
  "extracted_facts",
  {
    ...scoped(),
    evidenceItemId: uuid("evidence_item_id")
      .notNull()
      .references(() => evidenceItems.id),
    facts: jsonb("facts").notNull(),
    model: text("model").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id),
  },
  (t) => [
    index("extracted_facts_evidence_item_idx").on(t.evidenceItemId),
    index("extracted_facts_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const scopeChecks = pgTable(
  "scope_checks",
  {
    ...scoped(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => proofPacks.id),
    line: text("line").notNull(),
    verdict: verdict("verdict").notNull(),
    /** [{ evidence_item_id, quote, offsets }], quotes verified verbatim */
    citations: jsonb("citations").notNull().default([]),
  },
  (t) => [
    index("scope_checks_pack_idx").on(t.packId),
    index("scope_checks_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const clientAcks = pgTable(
  "client_acks",
  {
    ...scoped(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => proofPacks.id),
    tokenHash: text("token_hash").notNull(),
    acceptedAt: tstz("accepted_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    uniqueIndex("client_acks_token_hash_key").on(t.tokenHash),
    index("client_acks_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
