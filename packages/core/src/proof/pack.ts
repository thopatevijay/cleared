// ProofPack: one per payment. Its state machine follows docs/architecture.md §2 exactly.
import type { CaptureId, ProofPackId, WorkspaceId } from "../ids.ts";
import { transition, type Machine } from "../machine.ts";
import type { Result } from "../result.ts";
import type { DomainError } from "../errors.ts";
import type { Instant } from "../time.ts";

export const PACK_STATES = ["empty", "collecting", "checked", "ready", "stale"] as const;
export type PackState = (typeof PACK_STATES)[number];

export const PACK_EVENTS = ["evidence_added", "check_completed", "marked_ready"] as const;
export type PackEvent = (typeof PACK_EVENTS)[number];

export const proofPackMachine: Machine<PackState, PackEvent> = {
  name: "ProofPack",
  initial: "empty",
  states: PACK_STATES,
  events: PACK_EVENTS,
  table: {
    empty: { evidence_added: "collecting" },
    collecting: { check_completed: "checked" },
    checked: { marked_ready: "ready", evidence_added: "stale" },
    ready: { evidence_added: "stale" },
    stale: {},
  },
};

export function transitionPack(state: PackState, event: PackEvent): Result<PackState, DomainError> {
  return transition(proofPackMachine, state, event);
}

/** Scope-check verdicts. A verdict without a verbatim citation is `unverifiable` (ADR 0009). */
export const VERDICTS = ["met", "partial", "missing", "unverifiable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ProofPack {
  readonly id: ProofPackId;
  readonly workspaceId: WorkspaceId;
  readonly captureId: CaptureId;
  readonly state: PackState;
  readonly checkedAt: Instant | null;
}
