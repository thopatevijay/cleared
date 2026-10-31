// M2-10: the judge scenario step machine (pure). Step order and re-delivery guards, the poll's exit
// (terminal or 60 minutes), the decision control's gate and the outcome wording.
import { describe, expect, it } from "vitest";
import {
  advance,
  decisionAvailability,
  isStaleRun,
  isTerminal,
  pollExpired,
  pollVerdict,
  recordMilestones,
  SCENARIO_POLL_LIMIT_MS,
  SCENARIO_STALE_MS,
  SCENARIO_STATES,
  SCENARIO_STEPS,
  scenarioOutcomeKey,
  scenarioRequestIds,
  scenarioTimeline,
  ScenarioStepsSchema,
  type DecisionInput,
  type ScenarioState,
  type TimelineInput,
} from "./judge-dispute.ts";

describe("step machine", () => {
  it("walks capture → seed_pack → chargeback → poll in order", () => {
    let s: ScenarioState = "capturing";
    for (const step of SCENARIO_STEPS.slice(0, 3)) {
      const next = advance(s, step);
      expect(next).not.toBeNull();
      s = next ?? s;
    }
    expect(s).toBe("polling");
    expect(advance(s, "poll")).toBe("polling");
  });

  it("a step job in any other state is a no-op (re-delivery, out of order)", () => {
    for (const state of SCENARIO_STATES) {
      for (const step of SCENARIO_STEPS) {
        const ok = advance(state, step);
        const expected =
          (step === "capture" && state === "capturing") ||
          (step === "seed_pack" && state === "seeding") ||
          (step === "chargeback" && state === "charging_back") ||
          (step === "poll" && state === "polling");
        expect(ok !== null).toBe(expected);
      }
    }
  });

  it("request ids are distinct per step and stable per run", () => {
    const a = scenarioRequestIds("r1");
    expect(new Set(Object.values(a)).size).toBe(3);
    expect(scenarioRequestIds("r1")).toEqual(a);
  });
});

describe("poll verdict", () => {
  const t0 = Date.UTC(2026, 9, 31, 12);
  it("stops at RESOLVED once the capture is no longer PENDING", () => {
    expect(pollVerdict(t0, t0 + 60_000, { disputeStatus: "RESOLVED", captureStatus: "COMPLETED" })).toBe(
      "resolved",
    );
    expect(pollVerdict(t0, t0 + 60_000, { disputeStatus: "RESOLVED", captureStatus: "PENDING" })).toBe(
      "continue",
    );
    expect(pollVerdict(t0, t0 + 60_000, { disputeStatus: "UNDER_REVIEW", captureStatus: "COMPLETED" })).toBe(
      "continue",
    );
    expect(isTerminal({ disputeStatus: "RESOLVED", captureStatus: null })).toBe(false);
  });

  it("gives up at 60 minutes, not before", () => {
    const o = { disputeStatus: "WAITING_FOR_SELLER_RESPONSE", captureStatus: "PENDING" };
    expect(pollVerdict(t0, t0 + SCENARIO_POLL_LIMIT_MS - 1, o)).toBe("continue");
    expect(pollVerdict(t0, t0 + SCENARIO_POLL_LIMIT_MS, o)).toBe("timed_out");
    expect(pollExpired(t0, t0 + SCENARIO_POLL_LIMIT_MS)).toBe(true);
    expect(pollExpired(t0, t0 + 1)).toBe(false);
  });

  it("an active run past the stale window can be closed; a finished one is never stale", () => {
    expect(isStaleRun("polling", t0, t0 + SCENARIO_STALE_MS)).toBe(true);
    expect(isStaleRun("polling", t0, t0 + SCENARIO_STALE_MS - 1)).toBe(false);
    expect(isStaleRun("resolved", t0, t0 + SCENARIO_STALE_MS * 2)).toBe(false);
  });
});

describe("decision control", () => {
  const ready: DecisionInput = {
    paypalEnv: "sandbox",
    state: "polling",
    disputeId: "PP-R-ABC-1",
    ownsDispute: true,
    evidenceFiled: true,
    allowedActions: ["adjudicate", "provide_supporting_info", "require_evidence"],
    decisionRequested: false,
  };

  it("enabled only with sandbox + owned + evidence filed + adjudicate link", () => {
    expect(decisionAvailability(ready)).toEqual({ shown: true, enabled: true, reason: null });
  });

  it("absent (not merely disabled) outside the sandbox", () => {
    for (const env of ["live", "production", undefined]) {
      expect(decisionAvailability({ ...ready, paypalEnv: env })).toEqual({
        shown: false,
        enabled: false,
        reason: "not_sandbox",
      });
    }
  });

  it.each([
    [{ allowedActions: ["provide_evidence", "accept_claim"] }, "no_adjudicate_link"],
    [{ evidenceFiled: false }, "evidence_not_filed"],
    [{ ownsDispute: false }, "not_owned"],
    [{ disputeId: null }, "no_dispute"],
    [{ decisionRequested: true }, "already_requested"],
    [{ state: "resolved" as const }, "finished"],
  ])("disabled with %o → %s", (patch, reason) => {
    expect(decisionAvailability({ ...ready, ...patch })).toEqual({ shown: true, enabled: false, reason });
  });
});

describe("outcome wording", () => {
  it("payout + represented by PayPal is the 'PayPal covered the case' key; nothing before RESOLVED", () => {
    const covered = { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" };
    expect(scenarioOutcomeKey("RESOLVED", covered)).toBe("payout_paypal_covered");
    expect(scenarioOutcomeKey("UNDER_REVIEW", covered)).toBeNull();
    expect(scenarioOutcomeKey("RESOLVED", null)).toBeNull();
    expect(
      scenarioOutcomeKey("RESOLVED", { outcome_code: "RESOLVED_BUYER_FAVOUR", outcome_reason: null }),
    ).toBe("other");
  });
});

describe("milestones and timeline", () => {
  const snap = (p: Partial<Parameters<typeof recordMilestones>[1]> = {}) => ({
    disputeStatus: "OPEN",
    allowedActions: [] as string[],
    outcomeCode: null,
    captureStatus: "COMPLETED",
    captureReason: null,
    ...p,
  });

  it("records each milestone once, when PayPal first shows it (M0-05 order)", () => {
    let seen = recordMilestones(
      {},
      snap({ disputeStatus: "UNDER_REVIEW", allowedActions: ["provide_supporting_info"] }),
      "t1",
    );
    expect(seen).toEqual({});
    seen = recordMilestones(
      seen,
      snap({ captureStatus: "PENDING", captureReason: "BUYER_COMPLAINT", disputeStatus: "UNDER_REVIEW" }),
      "t2",
    );
    expect(seen.hold).toEqual({ at: "t2", status: "PENDING / BUYER_COMPLAINT" });
    seen = recordMilestones(
      seen,
      snap({
        disputeStatus: "WAITING_FOR_SELLER_RESPONSE",
        allowedActions: ["accept_claim", "provide_evidence"],
        captureStatus: "PENDING",
      }),
      "t3",
    );
    expect(seen.evidence_step).toEqual({ at: "t3", status: "WAITING_FOR_SELLER_RESPONSE" });
    seen = recordMilestones(
      seen,
      snap({ disputeStatus: "UNDER_REVIEW", allowedActions: ["adjudicate"], captureStatus: "PENDING" }),
      "t4",
    );
    expect(seen.decision_offered).toEqual({ at: "t4" });
    expect(seen.evidence_step?.at).toBe("t3");
    seen = recordMilestones(
      seen,
      snap({ disputeStatus: "RESOLVED", outcomeCode: "RESOLVED_WITH_PAYOUT", captureStatus: "PENDING" }),
      "t5",
    );
    expect(seen.resolved).toEqual({ at: "t5", outcomeCode: "RESOLVED_WITH_PAYOUT" });
    expect(seen.released).toBeUndefined();
    seen = recordMilestones(seen, snap({ disputeStatus: "RESOLVED", captureStatus: "COMPLETED" }), "t6");
    expect(seen.released).toEqual({ at: "t6", status: "COMPLETED" });
    expect(recordMilestones(seen, snap({ disputeStatus: "RESOLVED" }), "t7")).toEqual(seen);
  });

  const steps = ScenarioStepsSchema.parse({
    capture: { at: "t0", orderId: "O1", captureId: "C1", status: "COMPLETED", merchantId: "M1" },
    seed_pack: { at: "t0", packId: "p", evidenceItemIds: ["a", "b", "c"] },
    chargeback: { at: "t1", disputeId: "PP-R-1", adopted: false },
  });
  const base: TimelineInput = {
    state: "polling",
    steps,
    evidenceFiledAt: null,
    decisionRequestedAt: null,
    finishedAt: null,
  };

  it("shows real ids and marks the first unfinished step active; UNDER_REVIEW alone is not the evidence step", () => {
    const t = scenarioTimeline(base);
    expect(t.map((s) => s.status)).toEqual([
      "done",
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
    expect(t[0]?.paypalIds).toEqual(["O1", "C1"]);
    expect(t[2]?.paypalIds).toEqual(["PP-R-1"]);
    expect(t[3]?.observed).toBeNull();
    expect(t[6]?.observed).toBeNull();
  });

  it("each step keeps the time and status it was observed with", () => {
    const seen = {
      evidence_step: { at: "t3", status: "WAITING_FOR_SELLER_RESPONSE" },
      hold: { at: "t2", status: "PENDING / BUYER_COMPLAINT" },
      decision_offered: { at: "t5" },
    };
    const waiting = scenarioTimeline({ ...base, steps: { ...steps, seen }, evidenceFiledAt: "t4" });
    expect(waiting[3]).toMatchObject({ status: "done", at: "t3", observed: "WAITING_FOR_SELLER_RESPONSE" });
    expect(waiting[4]).toMatchObject({ status: "done", at: "t4" });
    expect(waiting[5]).toMatchObject({ status: "active", observed: "adjudicate" });
    expect(waiting[6]).toMatchObject({ status: "pending", observed: "PENDING / BUYER_COMPLAINT" });
    const done = scenarioTimeline({
      ...base,
      state: "resolved",
      steps: {
        ...steps,
        seen: {
          ...seen,
          resolved: { at: "t7", outcomeCode: "X" },
          released: { at: "t8", status: "COMPLETED" },
        },
      },
      evidenceFiledAt: "t4",
      decisionRequestedAt: "t6",
      finishedAt: "t9",
    });
    expect(done.every((s) => s.status === "done")).toBe(true);
    expect(done[6]).toMatchObject({ at: "t8", observed: "COMPLETED", paypalIds: ["C1"] });
  });

  it("a run that ended early marks its unfinished step failed", () => {
    const t = scenarioTimeline({ ...base, state: "timed_out" });
    expect(t[3]?.status).toBe("failed");
    expect(t[4]?.status).toBe("pending");
    const first = scenarioTimeline({ ...base, state: "failed", steps: {} });
    expect(first[0]?.status).toBe("failed");
  });
});
