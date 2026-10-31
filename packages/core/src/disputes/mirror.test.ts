// mapDispute / allowedActionsFromLinks over every recorded M0-05 dispute body (M2-06): allowed actions come
// only from the current links, the due date and outcome are PayPal's, and malformed bodies are refused.
import { describe, expect, it } from "vitest";
import { disputeBodies } from "../../test/helpers/fixtures.ts";
import { allowedActionsFromLinks, isDisputeOpen, mapDispute, type DisputeMirror } from "./mirror.ts";

function body(file: string): Record<string, unknown> {
  const found = disputeBodies("disputes").find((b) => b.file === file);
  if (found === undefined) throw new Error(`fixture ${file} missing`);
  return found.body;
}

function mirror(file: string): DisputeMirror {
  const r = mapDispute(body(file));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("allowedActionsFromLinks", () => {
  it("drops self, de-duplicates and sorts", () => {
    expect(
      allowedActionsFromLinks([
        { rel: "self" },
        { rel: "provide_evidence" },
        { rel: "accept_claim" },
        { rel: "accept_claim" },
      ]),
    ).toEqual(["accept_claim", "provide_evidence"]);
    expect(allowedActionsFromLinks([{ rel: "self" }])).toEqual([]);
  });
});

describe("mapDispute over the M0-05 full path", () => {
  it("UNDER_REVIEW offers provide_supporting_info only", () => {
    const m = mirror("disputes/full/state-2-under_review.json");
    expect(m.state.status).toEqual({ kind: "known", value: "UNDER_REVIEW" });
    expect(m.allowedActions).toEqual(["provide_supporting_info"]);
    expect(m.sellerResponseDueDate).toBeNull();
  });

  it("WAITING_FOR_SELLER_RESPONSE: reason, stage, due date, accept_claim + provide_evidence", () => {
    const m = mirror("disputes/full/state-3-waiting_for_seller_response.json");
    expect(m.disputeId).toBe("PP-R-UVC-10195076");
    expect(m.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED");
    expect(m.state.stage).toEqual({ kind: "known", value: "CHARGEBACK" });
    expect(m.sellerResponseDueDate).toBe("2026-11-09T04:59:59.000Z");
    expect(m.allowedActions).toEqual(["accept_claim", "provide_evidence"]);
    expect(m.captureId).toBe("794390931G848631R");
    expect(m.customId).toMatch(/^spike-/);
    expect(isDisputeOpen(m.state)).toBe(true);
  });

  it("RESOLVED carries PayPal's outcome verbatim and is closed", () => {
    const m = mirror("disputes/full/state-6-resolved.json");
    expect(m.outcome).toEqual({
      outcome_code: "RESOLVED_WITH_PAYOUT",
      outcome_reason: "REPRESENTED_BY_PAYPAL",
      amount_refunded: { currency_code: "USD", value: "64.00" },
    });
    expect(m.state.outcome).toEqual({ kind: "known", value: "RESOLVED_WITH_PAYOUT" });
    expect(m.allowedActions).toEqual([]);
    expect(isDisputeOpen(m.state)).toBe(false);
  });

  it("maps every recorded dispute body", () => {
    const all = disputeBodies("disputes");
    expect(all.length).toBeGreaterThan(20);
    for (const b of all) expect(mapDispute(b.body).ok, b.file).toBe(true);
  });
});

describe("mapDispute edge cases", () => {
  const base = body("disputes/full/state-3-waiting_for_seller_response.json");

  it("keeps an unknown status verbatim and treats it as open", () => {
    const r = mapDispute({ ...base, status: "SOMETHING_NEW" });
    expect(r.ok && r.value.state.status).toEqual({ kind: "unrecognised", raw: "SOMETHING_NEW" });
    expect(r.ok && isDisputeOpen(r.value.state)).toBe(true);
  });

  it("no disputed transaction, no stage, no reason, no links → nulls and no actions", () => {
    const { disputed_transactions: _t, dispute_life_cycle_stage: _s, reason: _r, links: _l, ...rest } = base;
    const r = mapDispute(rest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.captureId).toBeNull();
    expect(r.value.customId).toBeNull();
    expect(r.value.state.stage).toBeNull();
    expect(r.value.reason).toBeNull();
    expect(r.value.allowedActions).toEqual([]);
  });

  it("an outcome without reason or refund stores nulls", () => {
    const r = mapDispute({
      ...base,
      status: "RESOLVED",
      dispute_outcome: { outcome_code: "CANCELED_BY_BUYER" },
    });
    expect(r.ok && r.value.outcome).toEqual({
      outcome_code: "CANCELED_BY_BUYER",
      outcome_reason: null,
      amount_refunded: null,
    });
  });

  it.each([
    ["not an object", "x", "invalid_paypal_resource"],
    [
      "missing status",
      { dispute_id: "PP-R-1", update_time: "2026-10-29T05:00:00Z", links: [] },
      "invalid_paypal_resource",
    ],
    ["malformed id", { ...base, dispute_id: "../etc" }, "invalid_paypal_resource"],
    ["bad update_time", { ...base, update_time: "yesterday" }, "invalid_instant"],
    ["bad due date", { ...base, seller_response_due_date: "soon" }, "invalid_instant"],
  ])("refuses %s", (_name, input, code) => {
    const r = mapDispute(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});
