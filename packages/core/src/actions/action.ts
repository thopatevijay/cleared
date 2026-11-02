// Actions: the agent only proposes; a seller approval bound to the payload sha256 is required to
// execute (ADR 0010). The state machine is in state.ts; approval policy in policy.ts; execution checks
// in checks.ts.
import type { ActionId, DisputeId, Sha256, WorkspaceId } from "../ids.ts";
import type { Instant } from "../time.ts";
import type { JsonValue } from "./canonical-json.ts";
import type { ActionState } from "./state.ts";

/** One approved PayPal write each. Goods tracking is PayPal's product; ours is one approved action. */
export const ACTION_KINDS = [
  "add_tracking",
  "provide_evidence",
  "provide_supporting_info",
  "accept_claim",
  "record_service_completed",
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
