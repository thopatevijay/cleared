// M3-01 holds: the reconcile lock and the read models behind `GET /api/holds(/:id)` and the dashboard's
// held total. Every query is bound to one workspace, and the reads also require the capture to be owned
// by that workspace in `paypal_resource_owner` (ADR 0008), so an unowned or foreign capture never shows.
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import * as s from "../../schema/index.ts";
import type { Executor, Tx } from "../tx.ts";
import type { CurrencyTotal } from "../repos/workspace/payments-list.ts";

export type HoldRow = typeof s.holds.$inferSelect;
export type PaymentRowForHold = typeof s.payments.$inferSelect;
export type DisputeRowForHold = typeof s.disputes.$inferSelect;
export type ExplanationRow = typeof s.explanations.$inferSelect;

export interface HoldView {
  readonly hold: HoldRow;
  readonly payment: PaymentRowForHold;
  readonly dispute: DisputeRowForHold | null;
}

export function holdsRepo(db: Db, ws: string) {
  const active = and(eq(s.holds.workspaceId, ws), ne(s.holds.state, "released"));
  const owned = and(
    eq(s.paypalResourceOwner.resourceType, "capture"),
    eq(s.paypalResourceOwner.resourceId, s.payments.captureId),
    eq(s.paypalResourceOwner.workspaceId, ws),
  );

  async function disputesFor(
    paymentIds: readonly string[],
    ex: Executor,
  ): Promise<Map<string, DisputeRowForHold>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await ex
      .select()
      .from(s.disputes)
      .where(and(eq(s.disputes.workspaceId, ws), inArray(s.disputes.paymentId, [...paymentIds])))
      .orderBy(asc(s.disputes.createdAt));
    // the newest dispute on a payment wins
    return new Map(rows.flatMap((d) => (d.paymentId === null ? [] : [[d.paymentId, d] as const])));
  }

  async function views(where: ReturnType<typeof and>, ex: Executor): Promise<HoldView[]> {
    const rows = await ex
      .select({ hold: s.holds, payment: s.payments })
      .from(s.holds)
      .innerJoin(s.payments, and(eq(s.payments.id, s.holds.paymentId), eq(s.payments.workspaceId, ws)))
      .innerJoin(s.paypalResourceOwner, owned)
      .where(where)
      .orderBy(desc(s.holds.openedAt), desc(s.holds.id));
    const disputes = await disputesFor(
      rows.map((r) => r.payment.id),
      ex,
    );
    return rows.map((r) => ({ ...r, dispute: disputes.get(r.payment.id) ?? null }));
  }

  return {
    /** Locks the payment row for this transaction (one reconcile per payment at a time). */
    async lockPayment(paymentId: string, tx: Tx): Promise<PaymentRowForHold | null> {
      const rows = await tx
        .select()
        .from(s.payments)
        .where(and(eq(s.payments.workspaceId, ws), eq(s.payments.id, paymentId)))
        .for("update");
      return rows[0] ?? null;
    },
    /** The payment's active (not `released`) hold, newest first. */
    async activeFor(paymentId: string, tx: Executor): Promise<HoldRow | null> {
      const rows = await tx
        .select()
        .from(s.holds)
        .where(and(active, eq(s.holds.paymentId, paymentId)))
        .orderBy(desc(s.holds.openedAt))
        .limit(1);
      return rows[0] ?? null;
    },
    /** The newest dispute mirrored on a payment. */
    async disputeFor(paymentId: string, tx: Executor): Promise<DisputeRowForHold | null> {
      return (await disputesFor([paymentId], tx)).get(paymentId) ?? null;
    },
    /** Active holds on owned captures, newest first. */
    async listActive(ex: Executor = db): Promise<HoldView[]> {
      return views(active, ex);
    },
    /** One hold (any state) on an owned capture; null when absent, foreign or unowned. */
    async view(holdId: string, ex: Executor = db): Promise<HoldView | null> {
      const rows = await views(and(eq(s.holds.workspaceId, ws), eq(s.holds.id, holdId)), ex);
      return rows[0] ?? null;
    },
    /** Active holds on owned captures by payment id (the dashboard rows). */
    async activeByPayment(paymentIds: readonly string[], ex: Executor = db): Promise<Map<string, HoldRow>> {
      if (paymentIds.length === 0) return new Map();
      const rows = await ex
        .select({ hold: s.holds })
        .from(s.holds)
        .innerJoin(s.payments, eq(s.payments.id, s.holds.paymentId))
        .innerJoin(s.paypalResourceOwner, owned)
        .where(and(active, inArray(s.holds.paymentId, [...paymentIds])))
        .orderBy(asc(s.holds.openedAt));
      return new Map(rows.map((r) => [r.hold.paymentId, r.hold]));
    },
    /** M3-02: the newest explanation per locale of one hold in this workspace (at most one per locale). */
    async explanations(holdId: string, ex: Executor = db): Promise<ExplanationRow[]> {
      const rows = await ex
        .select()
        .from(s.explanations)
        .where(and(eq(s.explanations.workspaceId, ws), eq(s.explanations.holdId, holdId)))
        .orderBy(desc(s.explanations.createdAt), desc(s.explanations.id));
      const newest = new Map<string, ExplanationRow>();
      for (const r of rows) if (!newest.has(r.locale)) newest.set(r.locale, r);
      return [...newest.values()].sort((a, b) => a.locale.localeCompare(b.locale));
    },
    /** Amounts held by active derived holds, per currency (exact numeric sums; never across currencies). */
    async heldTotals(ex: Executor = db): Promise<CurrencyTotal[]> {
      return ex
        .select({ value: sql<string>`sum(${s.payments.amount})::text`, currency: s.payments.currency })
        .from(s.holds)
        .innerJoin(s.payments, and(eq(s.payments.id, s.holds.paymentId), eq(s.payments.workspaceId, ws)))
        .innerJoin(s.paypalResourceOwner, owned)
        .where(active)
        .groupBy(s.payments.currency)
        .orderBy(s.payments.currency);
    },
  };
}

export type HoldsRepo = ReturnType<typeof holdsRepo>;
