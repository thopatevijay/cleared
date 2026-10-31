// M2-02: the agent's only write (ADR 0010). Insert only: a proposed action and its `action.proposed`
// outbox row commit in one transaction. Approval and execution are M2-08.
import {
  canonicalHash,
  DomainEventSchema,
  fromEpochMs,
  type CheckedProposal,
  type WorkspaceId,
} from "@cleared/core";
import type { Db } from "../client.ts";
import { outboxRepo } from "../repos/platform/messaging.ts";
import { withTransaction, type Tx } from "../tx.ts";
import { proposedActions } from "../../schema/index.ts";

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
