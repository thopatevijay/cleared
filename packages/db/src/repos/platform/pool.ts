// M3-10 (ADR 0019): the review-hold pool (platform scope; never handed to a client as-is).
// - the pool rows the CLI creates, captures and lists
// - the assignment: one held, pool-owned, unassigned, fresh row moves to a target workspace in the caller's
//   transaction (owner rows for the order and the capture, then the payment, its holds and explanations),
//   with a `pool.assigned` audit entry. `FOR UPDATE SKIP LOCKED` keeps two concurrent assignments apart.
import {
  poolAssignableSince,
  poolRefusal,
  type Instant,
  type PoolRefusal,
  type ReviewPoolPurpose,
  type ReviewPoolState,
} from "@cleared/core";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { explanations, holds, payments, paypalResourceOwner, reviewHoldPool } from "../../../schema/index.ts";
import type { Executor, Tx } from "../../tx.ts";
import { authRepo } from "./auth.ts";

export type ReviewHoldPoolRow = typeof reviewHoldPool.$inferSelect;
export type NewReviewHoldPoolRow = Pick<
  typeof reviewHoldPool.$inferInsert,
  "orderId" | "poolWorkspaceId" | "purpose" | "amount" | "currency" | "approveUrl"
>;

export interface PoolCaptureMark {
  readonly captureId: string;
  readonly captureStatus: string;
  readonly captureReason: string | null;
  readonly capturedAt: Date;
  readonly state: Extract<ReviewPoolState, "held" | "not_held">;
}

export interface PoolAssignment {
  readonly poolId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly paymentId: string;
  readonly poolWorkspaceId: string;
  readonly workspaceId: string;
  readonly capturedAt: Date;
}

const ms = (d: Date): Instant => d.toISOString() as Instant;

export function reviewHoldPoolRepo(db: Db) {
  const audit = authRepo(db);
  return {
    async insert(row: NewReviewHoldPoolRow, tx?: Executor): Promise<ReviewHoldPoolRow> {
      const [r] = await (tx ?? db).insert(reviewHoldPool).values(row).returning();
      if (!r) throw new Error("review_hold_pool insert returned no row");
      return r;
    },
    /** The pool workspace every pool row names (the first pool:create makes it), or null before that. */
    async poolWorkspaceId(tx?: Executor): Promise<string | null> {
      const rows = await (tx ?? db)
        .select({ id: reviewHoldPool.poolWorkspaceId })
        .from(reviewHoldPool)
        .orderBy(asc(reviewHoldPool.createdAt))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    async list(tx?: Executor): Promise<ReviewHoldPoolRow[]> {
      return (tx ?? db).select().from(reviewHoldPool).orderBy(asc(reviewHoldPool.createdAt));
    },
    async inState(states: readonly ReviewPoolState[], tx?: Executor): Promise<ReviewHoldPoolRow[]> {
      return (tx ?? db)
        .select()
        .from(reviewHoldPool)
        .where(inArray(reviewHoldPool.state, [...states]))
        .orderBy(asc(reviewHoldPool.createdAt));
    },
    /** `awaiting_buyer` → `held` | `not_held`, once: a row already captured is left as it is. */
    async markCaptured(id: string, m: PoolCaptureMark, tx?: Executor): Promise<ReviewHoldPoolRow | null> {
      const [r] = await (tx ?? db)
        .update(reviewHoldPool)
        .set({ ...m, updatedAt: sql`now()` })
        .where(and(eq(reviewHoldPool.id, id), eq(reviewHoldPool.state, "awaiting_buyer")))
        .returning();
      return r ?? null;
    },
    /** `held` → `released` (PayPal moved the capture out of PENDING); the row stays as a released example. */
    async markReleased(id: string, captureStatus: string, tx?: Executor): Promise<ReviewHoldPoolRow | null> {
      const [r] = await (tx ?? db)
        .update(reviewHoldPool)
        .set({ state: "released", captureStatus, captureReason: null, updatedAt: sql`now()` })
        .where(and(eq(reviewHoldPool.id, id), eq(reviewHoldPool.state, "held")))
        .returning();
      return r ?? null;
    },
    async assignedTo(workspaceId: string, tx?: Executor): Promise<ReviewHoldPoolRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(reviewHoldPool)
        .where(eq(reviewHoldPool.assignedWorkspaceId, workspaceId))
        .limit(1);
      return rows[0] ?? null;
    },
    /**
     * Moves one assignable row of `purpose` to `workspaceId` in `tx`, or returns null when none is
     * available. Candidates: `held`, unassigned, captured under 20 h ago, the capture owned by the pool
     * workspace and its mirror still `PENDING`; each is re-checked with core `poolRefusal` under its lock.
     */
    async assign(
      input: { readonly workspaceId: string; readonly purpose: ReviewPoolPurpose; readonly now: Date },
      tx: Tx,
    ): Promise<PoolAssignment | null> {
      const candidate = await lockCandidate(tx, input.purpose, input.now);
      if (candidate === null) return null;
      const refusal = refusalOf(candidate, input.now);
      if (refusal !== null) throw new Error(`pool row ${candidate.id} changed under its lock: ${refusal}`);
      const moved = await move(tx, candidate, input.workspaceId, input.now);
      await audit.auditSystem(
        {
          workspaceId: input.workspaceId,
          action: "pool.assigned",
          detail: {
            poolId: moved.poolId,
            purpose: input.purpose,
            orderId: moved.orderId,
            captureId: moved.captureId,
            paymentId: moved.paymentId,
            fromWorkspaceId: moved.poolWorkspaceId,
            capturedAt: moved.capturedAt.toISOString(),
          },
        },
        tx,
      );
      return moved;
    },
  };
}

interface Candidate {
  readonly id: string;
  readonly orderId: string;
  readonly captureId: string | null;
  readonly state: string;
  readonly poolWorkspaceId: string;
  readonly assignedWorkspaceId: string | null;
  readonly capturedAt: Date | null;
  readonly ownerWorkspaceId: string;
  readonly paymentId: string;
  readonly mirrorStatus: string;
}

async function lockCandidate(tx: Tx, purpose: ReviewPoolPurpose, now: Date): Promise<Candidate | null> {
  const since = new Date(poolAssignableSince(ms(now)));
  const rows = await tx
    .select({
      id: reviewHoldPool.id,
      orderId: reviewHoldPool.orderId,
      captureId: reviewHoldPool.captureId,
      state: reviewHoldPool.state,
      poolWorkspaceId: reviewHoldPool.poolWorkspaceId,
      assignedWorkspaceId: reviewHoldPool.assignedWorkspaceId,
      capturedAt: reviewHoldPool.capturedAt,
      ownerWorkspaceId: paypalResourceOwner.workspaceId,
      paymentId: payments.id,
      mirrorStatus: payments.status,
    })
    .from(reviewHoldPool)
    .innerJoin(
      paypalResourceOwner,
      and(
        eq(paypalResourceOwner.resourceType, "capture"),
        eq(paypalResourceOwner.resourceId, reviewHoldPool.captureId),
        eq(paypalResourceOwner.workspaceId, reviewHoldPool.poolWorkspaceId),
      ),
    )
    .innerJoin(payments, eq(payments.captureId, reviewHoldPool.captureId))
    .where(
      and(
        eq(reviewHoldPool.purpose, purpose),
        eq(reviewHoldPool.state, "held"),
        isNull(reviewHoldPool.assignedWorkspaceId),
        gt(reviewHoldPool.capturedAt, since),
        lte(reviewHoldPool.capturedAt, now),
        eq(payments.status, "PENDING"),
      ),
    )
    .orderBy(desc(reviewHoldPool.capturedAt))
    .limit(1)
    .for("update", { of: [reviewHoldPool, paypalResourceOwner, payments], skipLocked: true });
  return rows[0] ?? null;
}

function refusalOf(c: Candidate, now: Date): PoolRefusal | null {
  return poolRefusal(
    {
      state: c.state as ReviewPoolState,
      poolWorkspaceId: c.poolWorkspaceId,
      ownerWorkspaceId: c.ownerWorkspaceId,
      assignedWorkspaceId: c.assignedWorkspaceId,
      capturedAt: c.capturedAt === null ? null : ms(c.capturedAt),
      mirrorStatus: c.mirrorStatus,
    },
    ms(now),
  );
}

async function move(tx: Tx, c: Candidate, target: string, now: Date): Promise<PoolAssignment> {
  const captureId = c.captureId ?? "";
  const pool = c.poolWorkspaceId;
  // only rows the pool owns move; anything else stays where it is
  await tx
    .update(paypalResourceOwner)
    .set({ workspaceId: target, transferredFrom: pool })
    .where(
      and(
        eq(paypalResourceOwner.workspaceId, pool),
        sql`(${paypalResourceOwner.resourceType}, ${paypalResourceOwner.resourceId}) in (('order', ${c.orderId}), ('capture', ${captureId}))`,
      ),
    );
  await tx
    .update(payments)
    .set({ workspaceId: target })
    .where(and(eq(payments.id, c.paymentId), eq(payments.workspaceId, pool)));
  const moved = await tx
    .update(holds)
    .set({ workspaceId: target })
    .where(and(eq(holds.paymentId, c.paymentId), eq(holds.workspaceId, pool)))
    .returning({ id: holds.id });
  if (moved.length > 0) {
    await tx
      .update(explanations)
      .set({ workspaceId: target })
      .where(
        and(
          inArray(
            explanations.holdId,
            moved.map((h) => h.id),
          ),
          eq(explanations.workspaceId, pool),
        ),
      );
  }
  await tx
    .update(reviewHoldPool)
    .set({ assignedWorkspaceId: target, assignedAt: now, updatedAt: now })
    .where(eq(reviewHoldPool.id, c.id));
  return {
    poolId: c.id,
    orderId: c.orderId,
    captureId,
    paymentId: c.paymentId,
    poolWorkspaceId: pool,
    workspaceId: target,
    capturedAt: c.capturedAt ?? now,
  };
}
