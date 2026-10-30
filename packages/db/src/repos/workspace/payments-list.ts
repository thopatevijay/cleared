// The dashboard's reads over `payments` and the sandbox test-payment counter (M1-07). Every query is
// bound to one workspace, like the rest of `forWorkspace`.
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor, Tx } from "../../tx.ts";
import type { Row } from "./scoped.ts";

/** The audit action written for each requested sandbox test payment (the per-day cap counts it). */
export const TEST_PAYMENT_REQUESTED = "sandbox.test_payment.requested";

export interface CurrencyTotal {
  readonly value: string;
  readonly currency: string;
}

export function paymentsListRepo(db: Db, ws: string) {
  const inScope = eq(s.payments.workspaceId, ws);
  return {
    /** Newest first, offset pagination (the caller bounds `limit`). */
    async page(offset: number, limit: number, tx?: Executor): Promise<Row<typeof s.payments>[]> {
      return (tx ?? db)
        .select()
        .from(s.payments)
        .where(inScope)
        .orderBy(desc(s.payments.createdAt), desc(s.payments.id))
        .offset(offset)
        .limit(limit);
    },
    async count(tx?: Executor): Promise<number> {
      const rows = await (tx ?? db).select({ n: count() }).from(s.payments).where(inScope);
      return rows[0]?.n ?? 0;
    },
    async countCreatedSince(since: Date, tx?: Executor): Promise<number> {
      const rows = await (tx ?? db)
        .select({ n: count() })
        .from(s.payments)
        .where(and(inScope, gte(s.payments.createdAt, since)));
      return rows[0]?.n ?? 0;
    },
    /** Sum of PayPal `PENDING` captures per currency (numeric sum: exact; never across currencies). */
    async heldTotals(tx?: Executor): Promise<CurrencyTotal[]> {
      const rows = await (tx ?? db)
        .select({ value: sql<string>`sum(${s.payments.amount})::text`, currency: s.payments.currency })
        .from(s.payments)
        .where(and(inScope, eq(s.payments.status, "PENDING")))
        .groupBy(s.payments.currency)
        .orderBy(s.payments.currency);
      return rows;
    },
  };
}

export function testPaymentRequestsRepo(db: Db, ws: string) {
  const requested = and(eq(s.auditLog.workspaceId, ws), eq(s.auditLog.action, TEST_PAYMENT_REQUESTED));
  return {
    /** Serialises requests per workspace inside the caller's transaction (the cap check is race-free). */
    async lock(tx: Tx): Promise<void> {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`test-payment:${ws}`}, 0))`);
    },
    /** Requests since `since`, and the oldest of them (null when none). */
    async since(since: Date, tx?: Executor): Promise<{ n: number; oldest: Date | null }> {
      const rows = await (tx ?? db)
        .select({ n: count(), oldest: sql<string | null>`min(${s.auditLog.createdAt})` })
        .from(s.auditLog)
        .where(and(requested, gte(s.auditLog.createdAt, since)));
      const r = rows[0];
      return { n: r?.n ?? 0, oldest: r?.oldest ? new Date(r.oldest) : null };
    },
    async record(messageId: string, tx: Tx): Promise<void> {
      await tx
        .insert(s.auditLog)
        .values({ workspaceId: ws, actor: "seller", action: TEST_PAYMENT_REQUESTED, detail: { messageId } });
    },
  };
}
