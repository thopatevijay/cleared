// Actions: the agent only proposes; a seller approval bound to the payload sha256 is required to
// execute (ADR 0010). `unknown` = sent but no answer; reconciled against PayPal to succeeded/failed.
import type { DomainError } from "../errors.ts";
import type { ActionId, DisputeId, Sha256, WorkspaceId } from "../ids.ts";
import { transition, type Machine } from "../machine.ts";
import type { Result } from "../result.ts";
import type { Instant } from "../time.ts";
import type { JsonValue } from "./canonical-json.ts";

export const ACTION_STATES = [
  "proposed",
  "approved",
  "rejected",
  "executing",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_EVENTS = ["approve", "reject", "start", "succeed", "fail", "time_out"] as const;
export type ActionEvent = (typeof ACTION_EVENTS)[number];

export const proposedActionMachine: Machine<ActionState, ActionEvent> = {
  name: "ProposedAction",
  initial: "proposed",
  states: ACTION_STATES,
  events: ACTION_EVENTS,
  table: {
    proposed: { approve: "approved", reject: "rejected" },
    approved: { start: "executing" },
    rejected: {},
    executing: { succeed: "succeeded", fail: "failed", time_out: "unknown" },
    // reconcile against PayPal
    unknown: { succeed: "succeeded", fail: "failed" },
    succeeded: {},
    failed: {},
  },
};

export function transitionAction(state: ActionState, event: ActionEvent): Result<ActionState, DomainError> {
  return transition(proposedActionMachine, state, event);
}

/** One approved PayPal write each. Goods tracking is PayPal's product; ours is one approved action. */
export const ACTION_KINDS = [
  "add_tracking",
  "provide_evidence",
  "provide_supporting_info",
  "accept_claim",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_RISKS = ["low", "medium", "high"] as const;
export type ActionRisk = (typeof ACTION_RISKS)[number];

export interface ProposedAction {
  readonly id: ActionId;
  readonly workspaceId: WorkspaceId;
  readonly kind: ActionKind;
  /** the dispute it acts on; null for a hold action */
  readonly disputeId: DisputeId | null;
  readonly payload: JsonValue;
  /** sha256 of canonicalJson(payload) */
  readonly payloadSha256: Sha256;
  readonly state: ActionState;
  readonly risk: ActionRisk;
  readonly createdByRunId: string | null;
}

export interface Approval {
  readonly actionId: ActionId;
  readonly approvedBy: string;
  readonly approvedAt: Instant;
  /** the exact draft hash the seller approved */
  readonly payloadSha256: Sha256;
}

export const AUDIT_ACTORS = ["seller", "agent", "system"] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

/** Append-only (no UPDATE/DELETE grants in M1-02). */
export interface AuditEntry {
  readonly workspaceId: WorkspaceId;
  readonly at: Instant;
  readonly actor: AuditActor;
  readonly action: string;
  readonly detail: JsonValue;
}
