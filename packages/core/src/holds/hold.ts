// Hold: a capture in PENDING with a reason, plus Cleared's workflow around it (architecture §2).
// The rule table, release estimates and explanations arrive in M3-01 / M3-02.
import type { DomainError } from "../errors.ts";
import type { CaptureId, HoldId, WorkspaceId } from "../ids.ts";
import { transition, type Machine } from "../machine.ts";
import type { Mirrored } from "../mirror.ts";
import type { PendingReason } from "../payments/capture.ts";
import type { Result } from "../result.ts";
import type { Instant } from "../time.ts";

export const HOLD_STATES = [
  "open",
  "explained",
  "action_proposed",
  "approved",
  "filed",
  "released",
  "still_held",
] as const;
export type HoldState = (typeof HOLD_STATES)[number];

export const HOLD_EVENTS = [
  "explanation_written",
  "action_proposed",
  "action_approved",
  "action_filed",
  "capture_released",
  "still_held_after_filing",
] as const;
export type HoldEvent = (typeof HOLD_EVENTS)[number];

export const holdMachine: Machine<HoldState, HoldEvent> = {
  name: "Hold",
  initial: "open",
  states: HOLD_STATES,
  events: HOLD_EVENTS,
  table: {
    open: { explanation_written: "explained" },
    explained: { action_proposed: "action_proposed" },
    action_proposed: { action_approved: "approved" },
    approved: { action_filed: "filed" },
    filed: { capture_released: "released", still_held_after_filing: "still_held" },
    released: {},
    still_held: {},
  },
};

export function transitionHold(state: HoldState, event: HoldEvent): Result<HoldState, DomainError> {
  return transition(holdMachine, state, event);
}

/** A release date is always an estimate with a cited source (CLAUDE.md domain rules): one or neither. */
export interface ReleaseEstimate {
  readonly at: Instant;
  readonly source: string;
}

export interface Hold {
  readonly id: HoldId;
  readonly workspaceId: WorkspaceId;
  readonly captureId: CaptureId;
  readonly reason: Mirrored<PendingReason>;
  readonly state: HoldState;
  readonly openedAt: Instant;
  readonly releasedAt: Instant | null;
  readonly estimate: ReleaseEstimate | null;
}
