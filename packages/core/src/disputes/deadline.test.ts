// The deadline position against a clock (M2-06 AC): due − 71 h → t72 (72 h alert), due − 23 h → t24
// (24 h alert), due − 59 min → closed_for_action; each boundary is inclusive.
import { describe, expect, it } from "vitest";
import { canExecute } from "../actions/policy.ts";
import { addMinutes, type Instant } from "../time.ts";
import { deadlineNotification, deadlineState, evaluateDeadline, type DeadlineState } from "./deadline.ts";

/** The M0-05 dispute's due date (fixtures/paypal/disputes/full/state-3). */
const DUE = "2026-11-09T04:59:59.000Z" as Instant;
const at = (minutesBeforeDue: number): Instant => addMinutes(DUE, -minutesBeforeDue);

describe("deadlineState", () => {
  it.each<[string, number, DeadlineState]>([
    ["due − 10 days", 10 * 24 * 60, "ok"],
    ["due − 72 h − 1 min", 72 * 60 + 1, "ok"],
    ["due − 72 h exactly", 72 * 60, "t72"],
    ["due − 71 h", 71 * 60, "t72"],
    ["due − 24 h − 1 min", 24 * 60 + 1, "t72"],
    ["due − 24 h exactly", 24 * 60, "t24"],
    ["due − 23 h", 23 * 60, "t24"],
    ["due − 61 min", 61, "t24"],
    ["due − 60 min exactly", 60, "closed_for_action"],
    ["due − 59 min", 59, "closed_for_action"],
    ["past due", -60, "closed_for_action"],
  ])("%s → %s", (_n, minutes, state) => {
    expect(deadlineState(DUE, at(minutes))).toBe(state);
  });

  it("closed_for_action starts exactly where canExecute starts refusing (past_deadline)", () => {
    for (const minutes of [61, 60, 59]) {
      const closed = deadlineState(DUE, at(minutes)) === "closed_for_action";
      const refused = canExecute(
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "provide_evidence",
          state: "approved",
          payloadSha256: "a".repeat(64),
        } as Parameters<typeof canExecute>[0],
        {
          now: at(minutes),
          dueDate: DUE,
          hasActionLink: true,
          approval: { actionId: "00000000-0000-4000-8000-000000000001", payloadSha256: "a".repeat(64) },
          payloadSha256: "a".repeat(64),
          killSwitch: false,
        } as Parameters<typeof canExecute>[1],
      );
      expect(refused.kind === "refuse" && refused.reason === "past_deadline").toBe(closed);
    }
  });
});

describe("deadlineNotification / evaluateDeadline", () => {
  it("only t72 and t24 call for an alert", () => {
    expect(deadlineNotification("ok")).toBeNull();
    expect(deadlineNotification("t72")).toBe("deadline_t72");
    expect(deadlineNotification("t24")).toBe("deadline_t24");
    expect(deadlineNotification("closed_for_action")).toBeNull();
  });

  it("an open dispute with a due date is evaluated", () => {
    expect(evaluateDeadline({ dueDate: DUE, open: true, now: at(71 * 60) })).toEqual({
      state: "t72",
      notify: "deadline_t72",
    });
    expect(evaluateDeadline({ dueDate: DUE, open: true, now: at(23 * 60) })).toEqual({
      state: "t24",
      notify: "deadline_t24",
    });
    expect(evaluateDeadline({ dueDate: DUE, open: true, now: at(59) })).toEqual({
      state: "closed_for_action",
      notify: null,
    });
  });

  it("no due date, or a resolved dispute, is not watched", () => {
    expect(evaluateDeadline({ dueDate: null, open: true, now: at(23 * 60) })).toBeNull();
    expect(evaluateDeadline({ dueDate: DUE, open: false, now: at(23 * 60) })).toBeNull();
  });
});
