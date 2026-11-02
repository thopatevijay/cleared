// Hold: a capture in PENDING with a reason, plus Cleared's workflow around it (architecture §2).
// M3-01 (ADR 0017, BL-01 6527422618): PayPal can release a hold at any time, whatever Cleared is doing,
// so `capture_released` leads to `released` from every state but `released` itself, `still_held`
// included. `released` is set only when the mirrored capture leaves PENDING.
import type { DomainError } from "../errors.ts";
import { transition, type Machine } from "../machine.ts";
import type { Result } from "../result.ts";

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
    open: { explanation_written: "explained", capture_released: "released" },
    explained: { action_proposed: "action_proposed", capture_released: "released" },
    action_proposed: { action_approved: "approved", capture_released: "released" },
    approved: { action_filed: "filed", capture_released: "released" },
    filed: { capture_released: "released", still_held_after_filing: "still_held" },
    released: {},
    still_held: { capture_released: "released" },
  },
};

export function transitionHold(state: HoldState, event: HoldEvent): Result<HoldState, DomainError> {
  return transition(holdMachine, state, event);
}

/** A hold Cleared still shows as money held (every state but `released`). */
export function isHoldActive(state: HoldState): boolean {
  return state !== "released";
}
