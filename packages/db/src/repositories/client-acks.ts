// M3-06: client acknowledgement links. Seller-side reads and writes are bound to one workspace; the public
// accept route finds a link by its token hash only (`clientAckByToken`), before any workspace is known.
// `rateLimit` counts anonymous attempts per bucket in a rolling window.
import { and, asc, count, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { WorkspaceIdSchema, type WorkspaceId, type WorkspaceKind } from "@cleared/core";
import type { Db } from "../client.ts";
import type { Executor, Tx } from "../tx.ts";
import * as s from "../../schema/index.ts";
import { isUuid } from "../repos/workspace/scoped.ts";

export type ClientAckRow = typeof s.clientAcks.$inferSelect;

export interface ScopeItemRef {
  readonly id: string;
  readonly sha256: string;
}

export function clientAcksRepo(db: Db, workspaceId: WorkspaceId) {
  const ws = WorkspaceIdSchema.parse(workspaceId);
  const inScope = eq(s.clientAcks.workspaceId, ws);
  return {
    /** The pack's current scope item: its newest `scope` evidence item, or null. */
    async currentScopeItem(packId: string, tx?: Executor): Promise<ScopeItemRef | null> {
      if (!isUuid(packId)) return null;
      const rows = await (tx ?? db)
        .select({ id: s.evidenceItems.id, sha256: s.evidenceItems.sha256 })
        .from(s.evidenceItems)
        .where(
          and(
            eq(s.evidenceItems.workspaceId, ws),
            eq(s.evidenceItems.packId, packId),
            eq(s.evidenceItems.kind, "scope"),
          ),
        )
        .orderBy(desc(s.evidenceItems.createdAt), desc(s.evidenceItems.id))
        .limit(1);
      return rows[0] ?? null;
    },
    /** The pack's newest link (any status), or null. */
    async latestForPack(packId: string, tx?: Executor): Promise<ClientAckRow | null> {
      if (!isUuid(packId)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(s.clientAcks)
        .where(and(inScope, eq(s.clientAcks.packId, packId)))
        .orderBy(desc(s.clientAcks.createdAt), desc(s.clientAcks.id))
        .limit(1);
      return rows[0] ?? null;
    },
    /** Open links of a scope item (neither accepted nor revoked; may be expired), oldest first. */
    async openForScopeItem(scopeItemId: string, tx: Tx): Promise<ClientAckRow[]> {
      return tx
        .select()
        .from(s.clientAcks)
        .where(
          and(
            inScope,
            eq(s.clientAcks.scopeItemId, scopeItemId),
            isNull(s.clientAcks.acceptedAt),
            isNull(s.clientAcks.revokedAt),
          ),
        )
        .orderBy(asc(s.clientAcks.createdAt));
    },
    async insert(
      values: Pick<ClientAckRow, "packId" | "tokenHash" | "scopeItemId" | "scopeSha256" | "expiresAt">,
      tx: Tx,
    ): Promise<ClientAckRow> {
      const rows = await tx
        .insert(s.clientAcks)
        .values({ ...values, workspaceId: ws })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return row;
    },
    async get(id: string, tx?: Executor): Promise<ClientAckRow | null> {
      if (!isUuid(id)) return null;
      const rows = await (tx ?? db)
        .select()
        .from(s.clientAcks)
        .where(and(inScope, eq(s.clientAcks.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    /** Revokes an open link of this pack; null when it is not ours, not this pack's, or already final. */
    async revoke(packId: string, id: string, at: Date, tx: Tx): Promise<ClientAckRow | null> {
      if (!isUuid(id) || !isUuid(packId)) return null;
      const rows = await tx
        .update(s.clientAcks)
        .set({ revokedAt: at })
        .where(
          and(
            inScope,
            eq(s.clientAcks.id, id),
            eq(s.clientAcks.packId, packId),
            isNull(s.clientAcks.acceptedAt),
            isNull(s.clientAcks.revokedAt),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
  };
}

export type ClientAcksRepo = ReturnType<typeof clientAcksRepo>;

/** What the public page shows, and the accept route needs, for one link. */
export interface ClientAckByToken {
  readonly ack: ClientAckRow;
  readonly workspaceExpiresAt: Date | null;
  /** BL-01 6569232529: a demo workspace (no `users` row) shows a synthetic seller name */
  readonly workspaceKind: WorkspaceKind;
  readonly amount: string;
  readonly currency: string;
  readonly sellerName: string | null;
  readonly scopeText: string | null;
  /** the pack's current scope item sha256 (null: none), to detect a changed scope */
  readonly currentScopeSha256: string | null;
}

/**
 * Pre-workspace lookup by token hash (the public page and accept route). With `tx`, the link row is
 * locked until the transaction ends, so concurrent accepts of one token serialise.
 */
export async function clientAckByToken(db: Db, tokenHash: string, tx?: Tx): Promise<ClientAckByToken | null> {
  const ex = tx ?? db;
  const base = ex.select().from(s.clientAcks).where(eq(s.clientAcks.tokenHash, tokenHash)).limit(1);
  const [ack] = tx === undefined ? await base : await base.for("update");
  if (ack === undefined) return null;
  const ws = ack.workspaceId;
  const [row] = await ex
    .select({
      expiresAt: s.workspaces.expiresAt,
      kind: s.workspaces.kind,
      amount: s.payments.amount,
      currency: s.payments.currency,
      scopeText: s.evidenceItems.text,
    })
    .from(s.proofPacks)
    .innerJoin(s.workspaces, eq(s.workspaces.id, s.proofPacks.workspaceId))
    .innerJoin(s.payments, and(eq(s.payments.id, s.proofPacks.paymentId), eq(s.payments.workspaceId, ws)))
    .innerJoin(
      s.evidenceItems,
      and(eq(s.evidenceItems.id, ack.scopeItemId), eq(s.evidenceItems.workspaceId, ws)),
    )
    .where(and(eq(s.proofPacks.id, ack.packId), eq(s.proofPacks.workspaceId, ws)))
    .limit(1);
  if (row === undefined) return null;
  const [user] = await ex
    .select({ name: s.users.displayName })
    .from(s.users)
    .where(eq(s.users.workspaceId, ws))
    .orderBy(asc(s.users.createdAt))
    .limit(1);
  const current = await clientAcksRepo(db, WorkspaceIdSchema.parse(ws)).currentScopeItem(ack.packId, ex);
  return {
    ack,
    workspaceExpiresAt: row.expiresAt,
    workspaceKind: row.kind,
    amount: row.amount,
    currency: row.currency,
    sellerName: user?.name ?? null,
    scopeText: row.scopeText,
    currentScopeSha256: current?.sha256 ?? null,
  };
}

/** Marks the locked link accepted, pointing at its evidence item. False when it was already final. */
export async function markClientAckAccepted(
  tx: Tx,
  id: string,
  v: { acceptedAt: Date; ip: string; userAgent: string; evidenceItemId: string },
): Promise<boolean> {
  const rows = await tx
    .update(s.clientAcks)
    .set(v)
    .where(and(eq(s.clientAcks.id, id), isNull(s.clientAcks.acceptedAt), isNull(s.clientAcks.revokedAt)))
    .returning({ id: s.clientAcks.id });
  return rows.length === 1;
}

/**
 * Records one hit in `bucket` and returns the hits in the window, this one included. Rows older than the
 * window are pruned for the bucket. Best effort under concurrency (no lock): a burst may overshoot a little.
 */
export async function rateLimitHit(db: Db, bucket: string, now: Date, windowMs: number): Promise<number> {
  const since = new Date(now.getTime() - windowMs);
  await db
    .delete(s.rateLimitHits)
    .where(and(eq(s.rateLimitHits.bucket, bucket), lt(s.rateLimitHits.at, since)));
  await db.insert(s.rateLimitHits).values({ bucket, at: now });
  const [row] = await db
    .select({ n: count() })
    .from(s.rateLimitHits)
    .where(and(eq(s.rateLimitHits.bucket, bucket), gte(s.rateLimitHits.at, since)));
  return row?.n ?? 0;
}
