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

describe("timeline", () => {
  const steps = ScenarioStepsSchema.parse({
    capture: { at: "2026-10-31T12:00:00Z", orderId: "O1", captureId: "C1", status: "COMPLETED" },
    seed_pack: { at: "2026-10-31T12:00:05Z", packId: "p", evidenceItemIds: ["a", "b", "c"] },
    chargeback: { at: "2026-10-31T12:00:10Z", disputeId: "PP-R-1", adopted: false },
  });
  const base: TimelineInput = {
    state: "polling",
    steps,
    dispute: { status: "OPEN", allowedActions: [], updatedAt: "2026-10-31T12:00:11Z" },
    capture: { status: "COMPLETED", reason: null },
    evidenceFiledAt: null,
    decisionRequestedAt: null,
    finishedAt: null,
  };

  it("shows real ids and marks the first unfinished step active", () => {
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
    expect(t[3]?.observed).toBe("OPEN");
  });

  it("evidence step open → filed → decision → outcome with the hold observed", () => {
    const waiting = scenarioTimeline({
      ...base,
      dispute: {
        status: "WAITING_FOR_SELLER_RESPONSE",
        allowedActions: ["accept_claim", "provide_evidence"],
        updatedAt: "x",
      },
      capture: { status: "PENDING", reason: "BUYER_COMPLAINT" },
    });
    expect(waiting[3]?.status).toBe("done");
    expect(waiting[4]?.status).toBe("active");
    const ready = scenarioTimeline({
      ...base,
      dispute: { status: "UNDER_REVIEW", allowedActions: ["adjudicate"], updatedAt: "y" },
      evidenceFiledAt: "2026-10-31T12:05:00Z",
    });
    expect(ready[5]).toMatchObject({ status: "active", observed: "adjudicate" });
    const done = scenarioTimeline({
      ...base,
      state: "resolved",
      dispute: { status: "RESOLVED", allowedActions: [], updatedAt: "z" },
      evidenceFiledAt: "a",
      decisionRequestedAt: "b",
      finishedAt: "c",
    });
    expect(done.every((s) => s.status === "done")).toBe(true);
    expect(done[6]).toMatchObject({ at: "c", observed: "COMPLETED", paypalIds: ["C1"] });
  });

  it("a run that ended early marks its unfinished step failed", () => {
    const t = scenarioTimeline({ ...base, state: "timed_out" });
    expect(t[3]?.status).toBe("failed");
    expect(t[4]?.status).toBe("pending");
    const first = scenarioTimeline({ ...base, state: "failed", steps: {}, dispute: null, capture: null });
    expect(first[0]?.status).toBe("failed");
    expect(first[6]?.observed).toBeNull();
  });
});
