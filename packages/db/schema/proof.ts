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
    /** M2-03: the extract prompt (`extract@v1`); one row per item and prompt version */
    promptVersion: text("prompt_version").notNull(),
  },
  (t) => [
    uniqueIndex("extracted_facts_item_prompt_key").on(t.evidenceItemId, t.promptVersion),
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
    /** [{ evidence_item_id, quote, offsets: {start, end}, sha256 }], quotes verified verbatim */
    citations: jsonb("citations").notNull().default([]),
    // M2-04: a check is a version of the pack's verdicts, one row per scope line. Append-only (migration
    // 0009): new evidence writes a new version and never edits an old row.
    /** 1, 2, … per pack; the newest version is the pack's current check */
    checkVersion: integer("check_version").notNull(),
    /** canonical hash of the pack's items (id, sha256, facts row) the check read */
    evidenceSetHash: sha256("evidence_set_hash").notNull(),
    /** the scope-check prompt (`check_scope@v1`) */
    promptVersion: text("prompt_version").notNull(),
    runId: uuid("run_id").references(() => agentRuns.id),
    /** the line's id inside its check (`C1`, …) */
    lineId: text("line_id").notNull(),
    /** the verified scope quote the line came from (same shape as one citation), or null */
    lineCitation: jsonb("line_citation"),
    /** what the model answered; `verdict` is what the verbatim check and the rules left of it */
    modelVerdict: verdict("model_verdict").notNull(),
    /** why the line is unverifiable (`no_valid_citation`, `image_only_support`, …), else null */
    note: text("note"),
    /** the model's rationale: data, rendered as plain text */
    rationale: text("rationale").notNull(),
  },
  (t) => [
    uniqueIndex("scope_checks_idempotency_key").on(t.packId, t.evidenceSetHash, t.promptVersion, t.lineId),
    uniqueIndex("scope_checks_version_line_key").on(t.packId, t.checkVersion, t.lineId),
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
