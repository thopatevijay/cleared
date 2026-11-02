// M2-02: the agent's only write (ADR 0010). Insert only: a proposed action and its `action.proposed`
// outbox row commit in one transaction. Approval and execution are M2-08.
import { and, eq } from "drizzle-orm";
import {
  canonicalHash,
  DomainEventSchema,
  fromEpochMs,
  type ActionFailureCode,
  type ActionState,
  type CheckedProposal,
  type JsonValue,
  type WorkspaceId,
} from "@cleared/core";
import type { Db } from "../client.ts";
import { outboxRepo } from "../repos/platform/messaging.ts";
import { withTransaction, type Executor, type Tx } from "../tx.ts";
import { proposedActions } from "../../schema/index.ts";
import { appendActionAudit } from "./audit-log.ts";

export interface NewProposal {
  readonly workspaceId: WorkspaceId;
  /** the agent run that proposed it (`created_by_run_id`) */
  readonly runId: string;
  readonly proposal: CheckedProposal;
  readonly at: Date;
}

/** Inserts inside the caller's transaction; returns the new action id. */
export async function insertProposedAction(db: Db, p: NewProposal, tx: Tx): Promise<string> {
  const sha = canonicalHash(p.proposal.payload);
  // the hash is recomputed here, so a stored row always satisfies payload_sha256 = canonicalHash(payload)
  if (sha !== p.proposal.payloadSha256) throw new Error("proposal payload_sha256 does not match its payload");
  const rows = await tx
    .insert(proposedActions)
    .values({
      workspaceId: p.workspaceId,
      kind: p.proposal.kind,
      payload: p.proposal.payload,
      payloadSha256: sha,
      state: "proposed",
      risk: p.proposal.risk,
      createdByRunId: p.runId,
    })
    .returning({ id: proposedActions.id });
  const id = rows[0]?.id;
  if (!id) throw new Error("proposed_actions insert returned no row");
  const event = DomainEventSchema.parse({
    type: "action.proposed",
    version: 1,
    workspaceId: p.workspaceId,
    occurredAt: fromEpochMs(p.at.getTime()),
    data: { actionId: id, kind: p.proposal.kind, payloadSha256: sha, runId: p.runId },
  });
  await outboxRepo(db).append({ topic: event.type, version: event.version, payload: event }, tx);
  // M2-08: every step of an action has an audit row, starting with the proposal.
  await appendActionAudit(
    db,
    {
      workspaceId: p.workspaceId,
      actionId: id,
      actor: "agent",
      action: "action.proposed",
      detail: { kind: p.proposal.kind, payloadSha256: sha, runId: p.runId },
    },
    tx,
  );
  return id;
}

/** Several proposals in one transaction (the caller's, or a new one). */
export async function insertProposedActions(
  db: Db,
  proposals: readonly NewProposal[],
  tx?: Tx,
): Promise<string[]> {
  const run = async (t: Tx) => {
    const ids: string[] = [];
    for (const p of proposals) ids.push(await insertProposedAction(db, p, t));
    return ids;
  };
  return tx ? run(tx) : withTransaction(db, run);
}

// ---- M2-08: approval and execution state ---------------------------------------------------------

export type ProposedActionRow = typeof proposedActions.$inferSelect;

/** The action in this workspace, or null. `lock` takes a row lock (`FOR UPDATE`) for the transaction. */
export async function getProposedAction(
  db: Db,
  workspaceId: string,
  actionId: string,
  opts: { readonly tx?: Executor; readonly lock?: boolean } = {},
): Promise<ProposedActionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(actionId)) return null;
  const q = (opts.tx ?? db)
    .select()
    .from(proposedActions)
    .where(and(eq(proposedActions.workspaceId, workspaceId), eq(proposedActions.id, actionId)))
    .limit(1);
  const rows = opts.lock === true ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/** Moves `from` → `to` (compare-and-set); false when the action was not in `from`. */
export async function setProposedActionState(
  db: Db,
  workspaceId: string,
  actionId: string,
  change: { readonly from: ActionState; readonly to: ActionState; readonly refusalCode?: ActionFailureCode },
  tx?: Executor,
): Promise<boolean> {
  const rows = await (tx ?? db)
    .update(proposedActions)
    .set({
      state: change.to,
      ...(change.refusalCode === undefined ? {} : { refusalCode: change.refusalCode }),
    })
    .where(
      and(
        eq(proposedActions.workspaceId, workspaceId),
        eq(proposedActions.id, actionId),
        eq(proposedActions.state, change.from),
      ),
    )
    .returning({ id: proposedActions.id });
  return rows.length === 1;
}

export interface SellerProposal {
  readonly workspaceId: string;
  /** user id, or the demo session id */
  readonly proposedBy: string;
  /** `accept_claim` (M2-08), a revised filing (M2-09), `add_tracking` (M3-03) or `record_service_completed` (M3-04) */
  readonly kind:
    | "accept_claim"
    | "provide_evidence"
    | "provide_supporting_info"
    | "add_tracking"
    | "record_service_completed";
  readonly payload: JsonValue;
  /** extra audit detail (M2-09: `revisionOf` = the superseded action) */
  readonly detail?: Readonly<Record<string, JsonValue>>;
}

/**
 * A seller-created proposal (`created_by_run_id` null): `accept_claim`, which the agent may never create,
 * or a draft the seller revised (M2-09). It still needs its own approval (accept_claim: typed confirmation).
 */
export async function insertSellerProposal(db: Db, p: SellerProposal, tx: Tx): Promise<ProposedActionRow> {
  const sha = canonicalHash(p.payload);
  const rows = await tx
    .insert(proposedActions)
    .values({
      workspaceId: p.workspaceId,
      kind: p.kind,
      payload: p.payload,
      payloadSha256: sha,
      risk: "high",
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("proposed_actions insert returned no row");
  await appendActionAudit(
    db,
    {
      workspaceId: p.workspaceId,
      actionId: row.id,
      actor: "seller",
      action: "action.proposed",
      detail: { ...p.detail, kind: p.kind, payloadSha256: sha, proposedBy: p.proposedBy },
    },
    tx,
  );
  return row;
}
