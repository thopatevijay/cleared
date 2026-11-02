// Evidence intake storage (M2-01): blobs, evidence items and the pack lock, bound to one workspace.
// `evidence_items` is append-only (migration 0002's trigger): this repository exposes insert and reads
// only, and has no update or delete of any kind. Blobs are content-addressed per workspace.
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { WorkspaceIdSchema, type PackState, type WorkspaceId } from "@cleared/core";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor, Tx } from "../../tx.ts";
import { isUuid, type NewRow, type Row } from "./scoped.ts";

export type EvidenceItemRow = Row<typeof s.evidenceItems>;
export type BlobRow = Row<typeof s.blobs>;
export type ProofPackRow = Row<typeof s.proofPacks>;
/** An evidence row with its blob's mime and size (null for a text item). */
export type EvidenceListRow = EvidenceItemRow & { mime: string | null; size: number | null };

export const EVIDENCE_LIST_MAX = 100;

const itemColumns = {
  id: s.evidenceItems.id,
  workspaceId: s.evidenceItems.workspaceId,
  packId: s.evidenceItems.packId,
  kind: s.evidenceItems.kind,
  blobId: s.evidenceItems.blobId,
  sha256: s.evidenceItems.sha256,
  text: s.evidenceItems.text,
  inputSha256: s.evidenceItems.inputSha256,
  createdAt: s.evidenceItems.createdAt,
  mime: s.blobs.mime,
  size: s.blobs.size,
};

function blobStore(db: Db, ws: string) {
  const inScope = eq(s.blobs.workspaceId, ws);
  return {
    /** Serialises writers of the same bytes in this workspace, so identical uploads share one row. */
    async lockSha256(sha256: string, tx: Tx): Promise<void> {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${ws}:${sha256}`}, 0))`);
    },
    async findBySha256(sha256: string, tx?: Executor): Promise<Omit<BlobRow, "bytes"> | null> {
      const rows = await (tx ?? db)
        .select({
          id: s.blobs.id,
          workspaceId: s.blobs.workspaceId,
          createdAt: s.blobs.createdAt,
          mime: s.blobs.mime,
          size: s.blobs.size,
          sha256: s.blobs.sha256,
        })
        .from(s.blobs)
        .where(and(inScope, eq(s.blobs.sha256, sha256)))
        .orderBy(s.blobs.createdAt)
        .limit(1);
      return rows[0] ?? null;
    },
    async insert(values: NewRow<typeof s.blobs>, tx: Tx): Promise<BlobRow> {
      const rows = await tx
        .insert(s.blobs)
        .values({ ...values, workspaceId: ws })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return row;
    },
    /** `null` when the id is not a uuid, is missing or belongs to another workspace. */
    async get(id: string, tx?: Executor): Promise<BlobRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(s.blobs)
        .where(and(inScope, eq(s.blobs.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

function evidenceItems(db: Db, ws: string) {
  const inScope = eq(s.evidenceItems.workspaceId, ws);
  return {
    async insert(values: NewRow<typeof s.evidenceItems>, tx: Tx): Promise<EvidenceItemRow> {
      const rows = await tx
        .insert(s.evidenceItems)
        .values({ ...values, workspaceId: ws })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return row;
    },
    async get(id: string, tx?: Executor): Promise<EvidenceItemRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(s.evidenceItems)
        .where(and(inScope, eq(s.evidenceItems.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    /** M3-07: the pack's scope snapshot for this input hash (the job's idempotency key), or null. */
    async snapshotForInput(packId: string, inputSha256: string, tx?: Executor): Promise<EvidenceItemRow | null> {
      if (!isUuid(packId)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(s.evidenceItems)
        .where(
          and(inScope, eq(s.evidenceItems.packId, packId), eq(s.evidenceItems.inputSha256, inputSha256)),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    /** One pack's items, newest first, with each blob's mime and size. */
    async listForPack(packId: string, tx?: Executor): Promise<EvidenceListRow[]> {
      if (!isUuid(packId)) return [];
      return (tx ?? db)
        .select(itemColumns)
        .from(s.evidenceItems)
        .leftJoin(s.blobs, eq(s.blobs.id, s.evidenceItems.blobId))
        .where(and(inScope, eq(s.evidenceItems.packId, packId)))
        .orderBy(desc(s.evidenceItems.createdAt), desc(s.evidenceItems.id))
        .limit(EVIDENCE_LIST_MAX);
    },
    async countForPack(packId: string, tx?: Executor): Promise<number> {
      const rows = await (tx ?? db)
        .select({ n: count() })
        .from(s.evidenceItems)
        .where(and(inScope, eq(s.evidenceItems.packId, packId)));
      return rows[0]?.n ?? 0;
    },
    /** Evidence bytes held by the workspace: every blob plus the UTF-8 size of text-only items. */
    async usageBytes(tx?: Executor): Promise<number> {
      const ex = tx ?? db;
      const [blobs] = await ex
        .select({ n: sql<string>`coalesce(sum(${s.blobs.size}), 0)::text` })
        .from(s.blobs)
        .where(eq(s.blobs.workspaceId, ws));
      const [texts] = await ex
        .select({ n: sql<string>`coalesce(sum(octet_length(${s.evidenceItems.text})), 0)::text` })
        .from(s.evidenceItems)
        .where(and(inScope, isNull(s.evidenceItems.blobId)));
      return Number(blobs?.n ?? 0) + Number(texts?.n ?? 0);
    },
  };
}

function packs(db: Db, ws: string) {
  const inScope = eq(s.proofPacks.workspaceId, ws);
  return {
    /** The pack, row-locked until the transaction ends; `null` outside this workspace. */
    async lock(packId: string, tx: Tx): Promise<ProofPackRow | null> {
      if (!isUuid(packId)) return null;
      const rows = await tx
        .select()
        .from(s.proofPacks)
        .where(and(inScope, eq(s.proofPacks.id, packId)))
        .limit(1)
        .for("update");
      return rows[0] ?? null;
    },
    /** A pack whose payment is in this workspace too (ownership: the pack's payment must be ours). */
    async getOwned(packId: string, tx?: Executor): Promise<ProofPackRow | null> {
      if (!isUuid(packId)) return null;
      const rows = await (tx ?? db)
        .select({ pack: s.proofPacks })
        .from(s.proofPacks)
        .innerJoin(s.payments, and(eq(s.payments.id, s.proofPacks.paymentId), eq(s.payments.workspaceId, ws)))
        .where(and(inScope, eq(s.proofPacks.id, packId)))
        .limit(1);
      return rows[0]?.pack ?? null;
    },
    async setState(packId: string, state: PackState, tx: Tx): Promise<void> {
      await tx
        .update(s.proofPacks)
        .set({ state })
        .where(and(inScope, eq(s.proofPacks.id, packId)));
    },
  };
}

/** Evidence storage for one workspace. Throws on a non-uuid workspace id; a foreign row id reads `null`. */
export function evidenceRepo(db: Db, workspaceId: WorkspaceId) {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  return {
    /**
     * Serialises evidence writes per workspace inside the caller's transaction, so the per-pack count and
     * the 200 MB workspace quota are checked race-free. Take it before any blob lock (one lock order).
     */
    async lockWorkspace(tx: Tx): Promise<void> {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`evidence:${ws}`}, 0))`);
    },
    blobs: blobStore(db, ws),
    items: evidenceItems(db, ws),
    packs: packs(db, ws),
  };
}

export type EvidenceRepo = ReturnType<typeof evidenceRepo>;
