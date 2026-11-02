// Every transition table is enumerated exhaustively: each state x event pair is either in the expected
// list below (written from docs/architecture.md §2, independently of src) and allowed, or forbidden.
import { describe, expect, it } from "vitest";
import {
  disputeDraftMachine,
  holdMachine,
  proofPackMachine,
  proposedActionMachine,
  terminalStates,
  transition,
  transitionAction,
  transitionDraft,
  transitionHold,
  transitionPack,
  type Machine,
} from "../src/index.ts";

type Allowed = readonly (readonly [from: string, event: string, to: string])[];

function pairs<S extends string, E extends string>(m: Machine<S, E>): [S, E][] {
  return m.states.flatMap((s) => m.events.map((e): [S, E] => [s, e]));
}

function exhaustive<S extends string, E extends string>(m: Machine<S, E>, allowed: Allowed): void {
  const expected = new Map(allowed.map(([from, ev, to]) => [`${from}|${ev}`, to]));

  it("lists every allowed pair in the table, and nothing else", () => {
    const actual = pairs(m).flatMap(([s, e]) => {
      const to = m.table[s][e];
      return to === undefined ? [] : [[s, e, to]];
    });
    expect(actual).toEqual(expect.arrayContaining(allowed.map((a) => [...a])));
    expect(actual).toHaveLength(allowed.length);
  });

  describe.each(pairs(m))("%s + %s", (state, event) => {
    const to = expected.get(`${state}|${event}`);
    if (to !== undefined) {
      it(`is allowed -> ${to}`, () => {
        expect(transition(m, state, event)).toEqual({ ok: true, value: to });
      });
    } else {
      it("is forbidden (invalid_transition)", () => {
        const r = transition(m, state, event);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("invalid_transition");
          expect(r.error.details).toEqual({ machine: m.name, state, event });
        }
      });
    }
  });
}

describe("ProofPack machine", () => {
  exhaustive(proofPackMachine, [
    ["empty", "evidence_added", "collecting"],
    ["collecting", "evidence_added", "collecting"],
    ["collecting", "check_completed", "checked"],
    ["checked", "marked_ready", "ready"],
    ["checked", "evidence_added", "stale"],
    ["ready", "evidence_added", "stale"],
    ["stale", "check_completed", "checked"],
  ]);
  it("starts empty; the typed wrapper delegates", () => {
    expect(proofPackMachine.initial).toBe("empty");
    expect(transitionPack("empty", "evidence_added")).toEqual({ ok: true, value: "collecting" });
    expect(transitionPack("stale", "check_completed")).toEqual({ ok: true, value: "checked" });
    expect(transitionPack("collecting", "evidence_added")).toEqual({ ok: true, value: "collecting" });
  });
});

describe("Hold machine", () => {
  exhaustive(holdMachine, [
    ["open", "explanation_written", "explained"],
    ["explained", "action_proposed", "action_proposed"],
    ["action_proposed", "action_approved", "approved"],
    ["approved", "action_filed", "filed"],
    ["filed", "capture_released", "released"],
    ["filed", "still_held_after_filing", "still_held"],
    // M3-01 (ADR 0017, BL-01 6527422618): PayPal releases a hold whatever Cleared is doing
    ["open", "capture_released", "released"],
    ["explained", "capture_released", "released"],
    ["action_proposed", "capture_released", "released"],
    ["approved", "capture_released", "released"],
    ["still_held", "capture_released", "released"],
  ]);
  it("starts open and ends released", () => {
    expect(holdMachine.initial).toBe("open");
    expect(terminalStates(holdMachine)).toEqual(["released"]);
    expect(transitionHold("filed", "capture_released")).toEqual({ ok: true, value: "released" });
  });
});

describe("Dispute draft machine (our states)", () => {
  exhaustive(disputeDraftMachine, [
    ["draft_ready", "draft_approved", "approved"],
    ["approved", "draft_filed", "filed"],
  ]);
  it("starts draft_ready; filed is terminal", () => {
    expect(disputeDraftMachine.initial).toBe("draft_ready");
    expect(terminalStates(disputeDraftMachine)).toEqual(["filed"]);
    expect(transitionDraft("draft_ready", "draft_filed").ok).toBe(false);
  });
});

describe("ProposedAction machine", () => {
  exhaustive(proposedActionMachine, [
    ["proposed", "approve", "approved"],
    ["proposed", "reject", "rejected"],
    ["approved", "start", "executing"],
    ["executing", "succeed", "succeeded"],
    ["executing", "fail", "failed"],
    ["executing", "time_out", "unknown"],
    ["unknown", "succeed", "succeeded"],
    ["unknown", "fail", "failed"],
  ]);
  it("goes executing -> unknown -> succeeded | failed (reconcile)", () => {
    expect(transitionAction("executing", "time_out")).toEqual({ ok: true, value: "unknown" });
    expect(transitionAction("unknown", "succeed")).toEqual({ ok: true, value: "succeeded" });
    expect(transitionAction("unknown", "fail")).toEqual({ ok: true, value: "failed" });
    expect(transitionAction("unknown", "start").ok).toBe(false);
    expect(terminalStates(proposedActionMachine)).toEqual(["rejected", "succeeded", "failed"]);
  });
});
