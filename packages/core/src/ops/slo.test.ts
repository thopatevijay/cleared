// M3-09 AC 4 (core half): each SLO check passes and breaches on crafted samples.
import { describe, expect, it } from "vitest";
import {
  approvedToPaypalCheck,
  holdVisibleCheck,
  missedDeadlinesCheck,
  percentile,
  reconcileFresh,
  SLO_TARGETS,
  SYNTHETIC_MAX_SECONDS,
  SYNTHETIC_STEPS,
  syntheticFreshCheck,
  syntheticRunCheck,
  syntheticStepCheck,
} from "../index.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const H = 3_600_000;

describe("percentile (nearest rank)", () => {
  it("is null for no samples and exact on small sets", () => {
    expect(percentile([], 99)).toBeNull();
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([3, 1, 2], 99)).toBe(3);
  });
  it("p99 of 1..200 is 198", () => {
    expect(
      percentile(
        Array.from({ length: 200 }, (_, i) => i + 1),
        99,
      ),
    ).toBe(198);
  });
});

describe("hold visible p99 < 2 min", () => {
  it("passes under the target and with no samples", () => {
    expect(holdVisibleCheck([1, 4, 30, 119])).toMatchObject({ pass: true, value: 119, target: 120 });
    expect(holdVisibleCheck([])).toMatchObject({ pass: true, value: null, detail: { samples: 0 } });
  });
  it("breaches at or over 2 min", () => {
    expect(holdVisibleCheck([1, 2, 120])).toMatchObject({ pass: false, value: 120 });
    expect(holdVisibleCheck([1, 2, 600])).toMatchObject({ check: "slo.hold_visible_p99", pass: false });
  });
});

describe("approved → PayPal 2xx p99 < 5 min", () => {
  it("passes and breaches", () => {
    expect(approvedToPaypalCheck([2, 10, 299])).toMatchObject({ pass: true, target: 300 });
    expect(approvedToPaypalCheck([2, 10, 301])).toMatchObject({
      check: "slo.approved_to_paypal_p99",
      pass: false,
      value: 301,
    });
  });
});

describe("missed dispute deadlines = 0", () => {
  const d = (over: Partial<Parameters<typeof missedDeadlinesCheck>[0][number]>) => ({
    disputeId: "PP-D-1",
    open: true,
    dueAtMs: NOW - H,
    filed: false,
    ...over,
  });
  it("passes when every past-due dispute is filed, resolved or has no due date", () => {
    const r = missedDeadlinesCheck(
      [d({ filed: true }), d({ open: false }), d({ dueAtMs: null }), d({ dueAtMs: NOW + H })],
      NOW,
    );
    expect(r).toMatchObject({ pass: true, value: 0, target: SLO_TARGETS.missedDeadlines });
  });
  it("breaches on an open, unfiled dispute past its due date", () => {
    const r = missedDeadlinesCheck([d({ disputeId: "PP-D-9" }), d({ filed: true })], NOW);
    expect(r).toMatchObject({ pass: false, value: 1, detail: { first: "PP-D-9", watched: 2 } });
  });
});

describe("last synthetic pass < 26 h", () => {
  it("passes when recent, breaches when old or never", () => {
    expect(syntheticFreshCheck(NOW - 25 * H, NOW)).toMatchObject({ pass: true, value: 25 * 3600 });
    expect(syntheticFreshCheck(NOW - 26 * H, NOW)).toMatchObject({ pass: false });
    expect(syntheticFreshCheck(null, NOW)).toMatchObject({ pass: false, value: null });
  });
});

describe("reconcile freshness (/readyz)", () => {
  it("is fresh under 30 minutes only", () => {
    expect(reconcileFresh(NOW - 29 * 60_000, NOW)).toBe(true);
    expect(reconcileFresh(NOW - 30 * 60_000, NOW)).toBe(false);
    expect(reconcileFresh(null, NOW)).toBe(false);
  });
});

describe("synthetic judge path budget", () => {
  it("each step has a budget and the whole path fits 30 min", () => {
    expect(SYNTHETIC_STEPS.map((s) => s.step)).toEqual([
      "capture",
      "chargeback",
      "buyer_complaint_hold",
      "evidence_proposed",
      "evidence_filed",
      "sandbox_decision",
      "released",
    ]);
    expect(syntheticStepCheck("buyer_complaint_hold", 299)).toMatchObject({ pass: true, target: 300 });
    expect(syntheticStepCheck("buyer_complaint_hold", 301)).toMatchObject({ pass: false });
    expect(syntheticRunCheck(900, null)).toMatchObject({ check: "synthetic", pass: true });
    expect(syntheticRunCheck(SYNTHETIC_MAX_SECONDS + 1, null).pass).toBe(false);
    expect(syntheticRunCheck(60, "capture")).toMatchObject({
      pass: false,
      detail: { failedStep: "capture" },
    });
    // a slow step is recorded, not a failure: the run passes when it is released within 30 min
    expect(syntheticRunCheck(900, null, ["buyer_complaint_hold"])).toMatchObject({
      pass: true,
      detail: { failedStep: null, slowSteps: "buyer_complaint_hold" },
    });
    expect(SYNTHETIC_STEPS.find((s) => s.step === "released")?.targetSeconds).toBe(900);
  });
});
