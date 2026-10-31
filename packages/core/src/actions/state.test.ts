// M2-08: the ProposedAction machine, every state × event pair against the ticket's table.
import { describe, expect, it } from "vitest";
import {
  ACTION_EVENTS,
  ACTION_STATES,
  ACTION_TERMINAL_STATES,
  nextActionState,
  transitionAction,
  type ActionEvent,
  type ActionState,
} from "../index.ts";

const ALLOWED: Readonly<Record<ActionState, Partial<Record<ActionEvent, ActionState>>>> = {
  proposed: { approve: "approved", reject: "rejected" },
  approved: { start: "executing" },
  rejected: {},
  executing: { succeed: "succeeded", fail: "failed", time_out: "unknown" },
  unknown: { succeed: "succeeded", fail: "failed" },
  succeeded: {},
  failed: {},
};

describe("ProposedAction state machine (M2-08)", () => {
  for (const state of ACTION_STATES) {
    for (const event of ACTION_EVENTS) {
      const expected = ALLOWED[state][event];
      it(`${state} --${event}--> ${expected ?? "refused"}`, () => {
        const r = transitionAction(state, event);
        if (expected === undefined) {
          expect(r.ok).toBe(false);
          expect(() => nextActionState(state, event)).toThrow(/not allowed/);
        } else {
          expect(r).toEqual({ ok: true, value: expected });
          expect(nextActionState(state, event)).toBe(expected);
        }
      });
    }
  }

  it("approved cannot skip to a result; unknown reconciles only to succeeded/failed", () => {
    expect(transitionAction("approved", "succeed").ok).toBe(false);
    expect(transitionAction("unknown", "time_out").ok).toBe(false);
    expect(transitionAction("unknown", "start").ok).toBe(false);
  });

  it("terminal states are rejected, succeeded, failed", () => {
    expect([...ACTION_TERMINAL_STATES].sort()).toEqual(["failed", "rejected", "succeeded"]);
  });
});
