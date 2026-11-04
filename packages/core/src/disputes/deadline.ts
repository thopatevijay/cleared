// The dispute deadline (M2-06): where a dispute stands against `seller_response_due_date` at a given
// clock, and which one-time alert that position calls for. Pure: the clock is an argument.
//
//   ok ──(due − 72 h)──▶ t72 ──(due − 24 h)──▶ t24 ──(due − 1 h)──▶ closed_for_action
//
// `closed_for_action` starts AT `due − DEADLINE_MARGIN_MINUTES` (the same cutoff as `canExecute`, which
// refuses at or after it). Each boundary is inclusive: the state changes at the instant itself.
import { DEADLINE_MARGIN_MINUTES } from "../actions/policy.ts";
import { addMinutes, compareInstants, type Instant } from "../instant.ts";

export const DEADLINE_STATES = ["ok", "t72", "t24", "closed_for_action"] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

/** Notification kinds the watcher writes, once each per dispute. */
export const DEADLINE_NOTIFICATION_KINDS = ["deadline_t72", "deadline_t24"] as const;
export type DeadlineNotificationKind = (typeof DEADLINE_NOTIFICATION_KINDS)[number];

export const DEADLINE_T72_HOURS = 72;
export const DEADLINE_T24_HOURS = 24;

/** Position of `now` against the due date. */
export function deadlineState(dueDate: Instant, now: Instant): DeadlineState {
  const atOrAfter = (minutesBeforeDue: number): boolean =>
    compareInstants(now, addMinutes(dueDate, -minutesBeforeDue)) >= 0;
  if (atOrAfter(DEADLINE_MARGIN_MINUTES)) return "closed_for_action";
  if (atOrAfter(DEADLINE_T24_HOURS * 60)) return "t24";
  if (atOrAfter(DEADLINE_T72_HOURS * 60)) return "t72";
  return "ok";
}

/**
 * The alert a state calls for: only the most urgent one (a dispute first seen inside 24 h gets the 24 h
 * alert, not both). `ok` and `closed_for_action` call for none: past the cutoff no action can be filed.
 */
export function deadlineNotification(state: DeadlineState): DeadlineNotificationKind | null {
  if (state === "t72") return "deadline_t72";
  if (state === "t24") return "deadline_t24";
  return null;
}

export interface DeadlineEvaluation {
  readonly state: DeadlineState;
  readonly notify: DeadlineNotificationKind | null;
}

/** State and alert for one dispute, or null when it has no due date or is closed (not watched). */
export function evaluateDeadline(input: {
  readonly dueDate: Instant | null;
  readonly open: boolean;
  readonly now: Instant;
}): DeadlineEvaluation | null {
  if (!input.open || input.dueDate === null) return null;
  const state = deadlineState(input.dueDate, input.now);
  return { state, notify: deadlineNotification(state) };
}
