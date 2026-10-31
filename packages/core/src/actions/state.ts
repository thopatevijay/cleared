// The ProposedAction state machine (ADR 0010, architecture §2). The agent only proposes; a seller
// approves or rejects; execution starts from `approved` only. `unknown` = sent but no answer, reconciled
// against PayPal into succeeded/failed and never resent.
//   proposed → approved | rejected
//   approved → executing → succeeded | failed | unknown
//   unknown  → succeeded | failed (reconcile only)
import type { DomainError } from "../errors.ts";
import { terminalStates, transition, type Machine } from "../machine.ts";
import type { Result } from "../result.ts";

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

/** `rejected`, `succeeded`, `failed`: nothing moves an action out of these. */
export const ACTION_TERMINAL_STATES: readonly ActionState[] = terminalStates(proposedActionMachine);

/** The next state, or a thrown error: for callers that already checked the current state. */
export function nextActionState(state: ActionState, event: ActionEvent): ActionState {
  const r = transitionAction(state, event);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
