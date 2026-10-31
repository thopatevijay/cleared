// Shared by `action.execute` and `action.reconcile` (M2-08): the transition + audit + outbox writes of one
// action step (always one transaction), the dispute snapshot reconcile compares, and the mirror refresh
// through `syncDispute` with a dispute that was already fetched (one GET, not two).
import {
  ACTION_KINDS,
  AgentEnvSchema,
  allowedActionsFromLinks,
  fromEpochMs,
  type ActionFailureCode,
  type ActionState,
  type DisputeSnapshot,
  type JsonValue,
} from "@cleared/core";
import { sellerSubmissions, type Dispute, type PayPalDisputesClient } from "@cleared/adapters";
import {
  ACTION_RECONCILE_QUEUE,
  appendActionAudit,
  setProposedActionState,
  type Db,
  type ProposedActionRow,
  type Publisher,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import type { ConsumeContext } from "../consume.ts";
import { syncDispute } from "./dispute-sync.ts";

export interface ActionRuntime {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly now: () => Date;
}

/** The kill switch's env half (`AGENT_KILL_SWITCH=true|1`), parsed the way the agent harness parses it. */
export function killSwitchFromEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  return AgentEnvSchema.shape.AGENT_KILL_SWITCH.parse(env["AGENT_KILL_SWITCH"]);
}

export const DisputeSnapshotSchema = z.object({
  status: z.string(),
  allowedActions: z.array(z.string()),
  sellerSubmissions: z.number().int().nonnegative().nullable(),
});

export function snapshotOf(d: Dispute): DisputeSnapshot {
  return { status: d.status, allowedActions: allowedActionsFromLinks(d.links), sellerSubmissions: sellerSubmissions(d) };
}

const kindOf = (row: ProposedActionRow) => z.enum(ACTION_KINDS).parse(row.kind);

export type Ending =
  | { readonly to: "succeeded"; readonly debugId: string | null }
  | { readonly to: "failed"; readonly code: ActionFailureCode; readonly debugId: string | null }
  | { readonly to: "unknown" };

/**
 * One state change of an action with its audit row and outbox event (`action.executed | action.failed |
 * action.unknown`, version 1), in `tx`. Throws when the action was not in `from` (the tx rolls back).
 */
export async function endAction(
  rt: ActionRuntime,
  tx: Tx,
  row: ProposedActionRow,
  from: ActionState,
  end: Ending,
  detail: Readonly<Record<string, JsonValue>> = {},
): Promise<void> {
  const refusal = end.to === "failed" ? { refusalCode: end.code } : {};
  if (!(await setProposedActionState(rt.db, row.workspaceId, row.id, { from, to: end.to, ...refusal }, tx))) {
    throw new Error(`action ${row.id} is no longer ${from}`);
  }
  const code = end.to === "failed" ? { code: end.code } : {};
  await appendActionAudit(
    rt.db,
    { workspaceId: row.workspaceId, actionId: row.id, actor: "system", action: `action.${end.to}`, detail: { ...detail, ...code } },
    tx,
  );
  const base = { version: 1 as const, workspaceId: row.workspaceId, occurredAt: fromEpochMs(rt.now().getTime()) };
  const ref = { actionId: row.id, kind: kindOf(row) };
  const event =
    end.to === "succeeded"
      ? { ...base, type: "action.executed" as const, data: { ...ref, paypalDebugId: end.debugId } }
      : end.to === "failed"
        ? { ...base, type: "action.failed" as const, data: { ...ref, paypalDebugId: end.debugId, reason: end.code } }
        : { ...base, type: "action.unknown" as const, data: ref };
  await rt.publisher.emit(tx, event as Parameters<Publisher["emit"]>[1]);
}

export interface ReconcileInput {
  readonly actionId: string;
  readonly workspaceId: string;
  readonly attempt: number;
  readonly before: DisputeSnapshot;
}

export async function enqueueReconcile(rt: ActionRuntime, tx: Tx, input: ReconcileInput, delaySeconds: number): Promise<void> {
  await rt.publisher.enqueue(tx, ACTION_RECONCILE_QUEUE, input, {
    workspaceId: input.workspaceId,
    startAfter: delaySeconds,
    // one reconcile job per (action, attempt), whatever redelivers
    singletonKey: `${input.actionId}:${String(input.attempt)}`,
  });
}

/** Refreshes the `disputes` mirror from a dispute body already fetched (M2-06 sync, no second GET). */
export async function mirrorFetched(
  rt: ActionRuntime,
  tx: Tx,
  fetched: Dispute,
  ctx: ConsumeContext,
): Promise<void> {
  const disputes: Pick<PayPalDisputesClient, "getDispute"> = { getDispute: () => Promise.resolve(fetched) };
  try {
    // a savepoint: a failed sync rolls back only itself, never the caller's transaction
    await tx.transaction((sp) =>
      syncDispute(
        { db: rt.db, publisher: rt.publisher, disputes, now: rt.now },
        { disputeId: fetched.dispute_id, source: "poll" },
        { ...ctx, tx: sp },
      ),
    );
  } catch (error) {
    // The checks use the fetched body itself; a mirror that cannot be written yet is not a refusal.
    ctx.log.warn({ disputeId: fetched.dispute_id, error: String(error) }, "dispute mirror not refreshed");
  }
}
