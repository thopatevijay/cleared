// `action.reconcile` (M2-08): an `unknown` send (timeout, reset or 5xx after the write left) is settled
// from PayPal's own state, never by resending. Each try re-fetches the dispute (and refreshes the
// mirror), then compares it with the snapshot taken before the send (core `reconcileVerdict`):
// - landed (link gone and status moved, or our submission listed) → `succeeded`;
// - not landed: schedule the next try (2, 4, 8, 16 min); after the 5th → `failed RECONCILE_NOT_APPLIED`.
//   The seller may approve a new action; nothing is ever re-sent automatically.
// Runs in the consumer's transaction (no PayPal write here, so the receipt makes it idempotent).
import {
  RECONCILE_MAX_TRIES,
  reconcileDelaySeconds,
  reconcileVerdict,
  type ReconcileVerdict,
} from "@cleared/core";
import type { PayPalDisputesClient } from "@cleared/adapters";
import { appendActionAudit, executionForAction, getProposedAction, type Tx } from "@cleared/db";
import { z } from "zod";
import type { ConsumeContext, Handler } from "../consume.ts";
import {
  DisputeSnapshotSchema,
  endAction,
  enqueueReconcile,
  mirrorFetched,
  snapshotOf,
  type ActionRuntime,
  type ReconcileInput,
} from "./action-runtime.ts";

export const ReconcileActionInputSchema = z.object({
  actionId: z.uuid(),
  workspaceId: z.uuid(),
  attempt: z.number().int().min(1).max(RECONCILE_MAX_TRIES),
  before: DisputeSnapshotSchema,
});

export interface ReconcileActionDeps extends ActionRuntime {
  readonly disputes: Pick<PayPalDisputesClient, "getDispute">;
}

export type ReconcileOutcome = "skipped" | "succeeded" | "retry_scheduled" | "failed";

export function reconcileActionHandler(deps: ReconcileActionDeps): Handler {
  return async (data, ctx) => {
    await reconcileAction(deps, ReconcileActionInputSchema.parse(data), ctx);
  };
}

export async function reconcileAction(
  deps: ReconcileActionDeps,
  input: ReconcileInput,
  ctx: ConsumeContext,
): Promise<ReconcileOutcome> {
  const { tx } = ctx;
  const row = await getProposedAction(deps.db, input.workspaceId, input.actionId, { tx, lock: true });
  if (row?.state !== "unknown") return "skipped";
  const disputeId = z.object({ dispute_id: z.string() }).parse(row.payload).dispute_id;
  // a failed re-read throws: the job retries (queue policy) without spending a reconcile try
  const fetched = await deps.disputes.getDispute(disputeId);
  await mirrorFetched(deps, tx, fetched, ctx);
  const after = snapshotOf(fetched);
  const verdict = reconcileVerdict(row.kind, input.before, after);
  await appendActionAudit(
    deps.db,
    {
      workspaceId: row.workspaceId,
      actionId: row.id,
      actor: "system",
      action: "action.reconcile",
      detail: { attempt: input.attempt, verdict, status: after.status, links: [...after.allowedActions] },
    },
    tx,
  );
  ctx.log.info({ actionId: row.id, attempt: input.attempt, verdict }, "action reconcile");
  return settle(deps, tx, row, input, verdict);
}

async function settle(
  deps: ReconcileActionDeps,
  tx: Tx,
  row: NonNullable<Awaited<ReturnType<typeof getProposedAction>>>,
  input: ReconcileInput,
  verdict: ReconcileVerdict,
): Promise<ReconcileOutcome> {
  if (verdict === "landed") {
    const execution = await executionForAction(deps.db, row.workspaceId, row.id, tx);
    const debugId = execution?.paypalDebugId ?? null;
    await endAction(deps, tx, row, "unknown", { to: "succeeded", debugId }, { reconciledOnAttempt: input.attempt });
    return "succeeded";
  }
  if (input.attempt < RECONCILE_MAX_TRIES) {
    const next = input.attempt + 1;
    await enqueueReconcile(deps, tx, { ...input, attempt: next }, reconcileDelaySeconds(next));
    return "retry_scheduled";
  }
  await endAction(
    deps,
    tx,
    row,
    "unknown",
    { to: "failed", code: "RECONCILE_NOT_APPLIED", debugId: null },
    { attempts: input.attempt },
  );
  return "failed";
}
