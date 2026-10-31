// M2-08: a seller approval, bound to the payload sha256 the seller saw (ADR 0010), and the seller's
// decision itself. Approve writes the `approvals` row, state `approved`, the audit row, the
// `action.approved` outbox event and the `action.execute` job in one transaction, under a row lock.
import { and, desc, eq } from "drizzle-orm";
import {
  ActionIdSchema,
  checkApproval,
  fromEpochMs,
  Sha256Schema,
  WorkspaceIdSchema,
  type ApprovalRefusal,
} from "@cleared/core";
import type { Db } from "../client.ts";
import type { Publisher } from "../outbox/index.ts";
import { ACTION_EXECUTE_QUEUE } from "../queue-policy.ts";
import { withTransaction, type Executor, type Tx } from "../tx.ts";
import { approvals } from "../../schema/index.ts";
import { appendActionAudit } from "./audit-log.ts";
import { getProposedAction, setProposedActionState, type ProposedActionRow } from "./proposed-actions.ts";

export type ApprovalRow = typeof approvals.$inferSelect;

export interface NewApproval {
  readonly workspaceId: string;
  readonly actionId: string;
  /** user id, or the demo session id */
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly payloadSha256: string;
}

export async function insertApproval(db: Db, a: NewApproval, tx?: Executor): Promise<ApprovalRow> {
  const rows = await (tx ?? db).insert(approvals).values(a).returning();
  const row = rows[0];
  if (!row) throw new Error("approvals insert returned no row");
  return row;
}

/** The action's latest approval in this workspace, or null. */
export async function approvalForAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  tx?: Executor,
): Promise<ApprovalRow | null> {
  const rows = await (tx ?? db)
    .select()
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.actionId, actionId)))
    .orderBy(desc(approvals.approvedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---- the seller's decision (the approve / reject routes) ----------------------------------------

export interface Decision {
  readonly workspaceId: string;
  readonly actionId: string;
  /** user id, or the demo session id */
  readonly actor: string;
  readonly now: Date;
}

export interface ApproveRequest extends Decision {
  readonly payloadSha256: string;
  readonly typedConfirmation?: string | undefined;
}

export type DecisionResult =
  | { readonly ok: true; readonly action: ProposedActionRow }
  | { readonly ok: false; readonly code: ApprovalRefusal | "NOT_FOUND" };

/** Approves under a row lock. A refusal changes nothing but its own audit row (actor seller). */
export function approveProposedAction(
  db: Db,
  publisher: Publisher,
  r: ApproveRequest,
): Promise<DecisionResult> {
  return withTransaction(db, async (tx): Promise<DecisionResult> => {
    const row = await getProposedAction(db, r.workspaceId, r.actionId, { tx, lock: true });
    if (row === null) return { ok: false, code: "NOT_FOUND" };
    const decision = checkApproval(row, {
      payloadSha256: r.payloadSha256,
      typedConfirmation: r.typedConfirmation,
    });
    if (decision.kind === "refuse") {
      await sellerAudit(db, tx, row, "action.approval_refused", {
        code: decision.code,
        by: r.actor,
        payloadSha256: r.payloadSha256,
      });
      return { ok: false, code: decision.code };
    }
    const approval = {
      workspaceId: row.workspaceId,
      actionId: row.id,
      approvedBy: r.actor,
      approvedAt: r.now,
    };
    await insertApproval(db, { ...approval, payloadSha256: row.payloadSha256 }, tx);
    await setProposedActionState(db, row.workspaceId, row.id, { from: "proposed", to: "approved" }, tx);
    await sellerAudit(db, tx, row, "action.approved", {
      approvedBy: r.actor,
      payloadSha256: row.payloadSha256,
    });
    await emitApproved(publisher, tx, row, r);
    const job = { actionId: row.id, workspaceId: row.workspaceId };
    await publisher.enqueue(tx, ACTION_EXECUTE_QUEUE, job, {
      workspaceId: row.workspaceId,
      singletonKey: row.id,
    });
    return { ok: true, action: { ...row, state: "approved" } };
  });
}

async function emitApproved(
  publisher: Publisher,
  tx: Tx,
  row: ProposedActionRow,
  r: ApproveRequest,
): Promise<void> {
  await publisher.emit(tx, {
    type: "action.approved",
    version: 1,
    workspaceId: WorkspaceIdSchema.parse(row.workspaceId),
    occurredAt: fromEpochMs(r.now.getTime()),
    data: {
      actionId: ActionIdSchema.parse(row.id),
      kind: row.kind,
      payloadSha256: Sha256Schema.parse(row.payloadSha256),
      approvedBy: r.actor,
    },
  });
}

async function sellerAudit(
  db: Db,
  tx: Tx,
  row: ProposedActionRow,
  action: string,
  detail: Record<string, string>,
): Promise<void> {
  await appendActionAudit(
    db,
    { workspaceId: row.workspaceId, actionId: row.id, actor: "seller", action, detail },
    tx,
  );
}

/** `proposed` → `rejected` with its audit row; anything else is ACTION_NOT_PROPOSED. */
export function rejectProposedAction(db: Db, r: Decision): Promise<DecisionResult> {
  return withTransaction(db, async (tx): Promise<DecisionResult> => {
    const row = await getProposedAction(db, r.workspaceId, r.actionId, { tx, lock: true });
    if (row === null) return { ok: false, code: "NOT_FOUND" };
    if (
      !(await setProposedActionState(db, row.workspaceId, row.id, { from: "proposed", to: "rejected" }, tx))
    ) {
      await sellerAudit(db, tx, row, "action.reject_refused", { code: "ACTION_NOT_PROPOSED", by: r.actor });
      return { ok: false, code: "ACTION_NOT_PROPOSED" };
    }
    await sellerAudit(db, tx, row, "action.rejected", { rejectedBy: r.actor });
    return { ok: true, action: { ...row, state: "rejected" } };
  });
}
