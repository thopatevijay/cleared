// M2-08: one `executions` row per action. `idempotency_key` = the action id (unique), also sent as
// `PayPal-Request-Id`. The row is claimed and committed BEFORE the PayPal call, so a redelivered job finds
// it and never sends a second time (DISPUTE_WRITES_IDEMPOTENT is false: M0-05 measured duplicates).
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor } from "../tx.ts";
import { executions } from "../../schema/index.ts";

export type ExecutionRow = typeof executions.$inferSelect;

/** Inserts the action's execution row; null when one already exists (a redelivery). */
export async function claimExecution(
  db: Db,
  c: { readonly workspaceId: string; readonly actionId: string },
  tx?: Executor,
): Promise<ExecutionRow | null> {
  const rows = await (tx ?? db)
    .insert(executions)
    .values({ workspaceId: c.workspaceId, actionId: c.actionId, idempotencyKey: c.actionId, attempt: 1 })
    .onConflictDoNothing({ target: executions.idempotencyKey })
    .returning();
  return rows[0] ?? null;
}

export async function executionForAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  tx?: Executor,
): Promise<ExecutionRow | null> {
  const rows = await (tx ?? db)
    .select()
    .from(executions)
    .where(and(eq(executions.workspaceId, workspaceId), eq(executions.actionId, actionId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface ExecutionOutcome {
  /** PayPal's HTTP status as text (`"200"`, `"422"`), or null when no answer came */
  readonly paypalStatus: string | null;
  readonly paypalDebugId: string | null;
  readonly response: unknown;
}

export async function recordExecutionOutcome(
  db: Db,
  workspaceId: string,
  actionId: string,
  o: ExecutionOutcome,
  tx?: Executor,
): Promise<void> {
  await (tx ?? db)
    .update(executions)
    .set({ paypalStatus: o.paypalStatus, paypalDebugId: o.paypalDebugId, response: o.response ?? null })
    .where(and(eq(executions.workspaceId, workspaceId), eq(executions.actionId, actionId)));
}
