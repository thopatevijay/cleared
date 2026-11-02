// M3-01: hold derivation over the recorded captures, the cited rule table's coverage of the Orders spec
// enum, the sources and the "estimated" label, and that sample rows can never be derived.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PENDING_REASONS } from "../payments/capture.ts";
import { parseInstant, type Instant } from "../time.ts";
import { deriveHold } from "./derive.ts";
import {
  addBusinessDays,
  ESTIMATE_LABEL,
  HOLD_RULES,
  holdRule,
  ruleForReason,
  SAMPLE_RULES,
} from "./rules.ts";
import { holdMachine, HOLD_STATES, isHoldActive, transitionHold } from "./state.ts";

const FIXTURES = new URL("../../../../fixtures/", import.meta.url);

interface Body {
  status?: string;
  capture_status?: string;
  status_details?: { reason?: string } | null;
  update_time?: string;
  create_time?: string;
}

function body(path: string): Body {
  const f = JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as { response: { body: Body } };
  return f.response.body;
}

function at(raw: string): Instant {
  const r = parseInstant(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
}

/** The capture facts the consumer reads from the mirrored payment row. */
function facts(b: Body, seenAt = "2026-10-26T11:24:21Z") {
  return {
    status: b.status ?? b.capture_status ?? "",
    reason: b.status_details?.reason ?? null,
    updateTime: at(b.update_time ?? seenAt),
  };
}

describe("deriveHold over recorded captures", () => {
  it("PENDING_REVIEW (spike wallet review) → a payment_review hold, 24 h estimate, 3 business days bound", () => {
    const h = deriveHold(facts(body("paypal/captures/pending-review.json")));
    expect(h).toMatchObject({
      type: "review",
      reason: "PENDING_REVIEW",
      openedAt: "2026-10-26T11:24:21.000Z",
      estimatedReleaseAt: "2026-10-27T11:24:21.000Z",
      estimateRuleId: "payment_review",
      disputeId: null,
    });
    // Monday 26 Oct + 3 business days = Thursday 29 Oct
    expect(h?.estimate).toEqual({
      at: "2026-10-27T11:24:21.000Z",
      upperBound: "2026-10-29T11:24:21.000Z",
      label: "estimated",
    });
  });

  it("the released wallet-review capture (COMPLETED) → no hold", () => {
    expect(deriveHold(facts(body("paypal/captures/pending-review-released.json")))).toBeNull();
  });

  it("M0-05 chargeback: PENDING / BUYER_COMPLAINT → a dispute hold with no date, linked to the dispute", () => {
    const b = body("paypal/disputes/full/capture-2-pending.json");
    const due = at("2026-11-09T04:59:59Z");
    const h = deriveHold(facts(b), { disputeId: "PP-R-X", status: "OPEN", sellerResponseDueDate: due });
    expect(h).toMatchObject({
      type: "dispute",
      reason: "BUYER_COMPLAINT",
      openedAt: "2026-10-29T05:20:04.000Z",
      estimatedReleaseAt: null,
      estimate: null,
      estimateRuleId: "dispute_hold",
      disputeId: "PP-R-X",
      disputeDueAt: due,
    });
  });

  it("M0-05 COMPLETED captures (before and after the dispute) → no hold", () => {
    expect(deriveHold(facts(body("paypal/disputes/full/capture-1-completed.json")))).toBeNull();
    expect(deriveHold(facts(body("paypal/disputes/full/capture-3-completed.json")))).toBeNull();
  });

  it("PENDING without a reason is not a hold; a non-dispute hold ignores a dispute", () => {
    const t = at("2026-10-26T00:00:00Z");
    expect(deriveHold({ status: "PENDING", reason: null, updateTime: t })).toBeNull();
    const h = deriveHold(
      { status: "PENDING", reason: "ECHECK", updateTime: t },
      { disputeId: "PP-R-Y", status: "OPEN", sellerResponseDueDate: null },
    );
    expect(h).toMatchObject({ type: "other", estimateRuleId: "reason_ECHECK", disputeId: null });
    expect(h?.estimatedReleaseAt).toBeNull();
  });

  it("an unknown future reason keeps PayPal's string and falls back to the OTHER row", () => {
    const h = deriveHold({
      status: "PENDING",
      reason: "SOMETHING_NEW",
      updateTime: at("2026-10-26T00:00:00Z"),
    });
    expect(h).toMatchObject({ reason: "SOMETHING_NEW", estimateRuleId: "reason_OTHER" });
  });
});

describe("cited rule table", () => {
  const spec = JSON.parse(
    readFileSync(new URL("paypal/spec/capture-status-details-reason.json", FIXTURES), "utf8"),
  ) as { enum: string[]; descriptions: Record<string, string> };

  it("has a row for every capture_status_details.reason in the Orders spec", () => {
    expect(spec.enum.length).toBeGreaterThanOrEqual(12);
    const missing = spec.enum.filter(
      (r) => !HOLD_RULES.some((row) => row.appliesTo.kind === "reason" && row.appliesTo.reasons.includes(r)),
    );
    expect(missing).toEqual([]);
    // core's mirrored PENDING reasons are all in the spec too
    expect(PENDING_REASONS.filter((r) => !spec.enum.includes(r))).toEqual([]);
  });

  it("quotes the spec verbatim for reasons whose only source is the spec", () => {
    for (const r of spec.enum) {
      const row = ruleForReason(r);
      if (!row.id.startsWith("reason_")) continue;
      expect(row.sources[0].quote).toBe(spec.descriptions[r]);
      expect(row.estimate(at("2026-10-26T00:00:00Z"))).toBeNull();
    }
  });

  it("every row has a non-empty source url, quote and retrieved_at; ids are unique", () => {
    expect(new Set(HOLD_RULES.map((r) => r.id)).size).toBe(HOLD_RULES.length);
    for (const row of HOLD_RULES) {
      for (const s of row.sources) {
        expect(s.url).toMatch(/^https:\/\/\S+$/);
        expect(s.quote.trim().length).toBeGreaterThan(0);
        expect(s.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("every estimate is labelled 'estimated'", () => {
    const from = at("2026-10-30T10:00:00Z");
    expect(ESTIMATE_LABEL).toBe("estimated");
    const dated = HOLD_RULES.map((r) => r.estimate(from)).filter((e) => e !== null);
    expect(dated.length).toBeGreaterThanOrEqual(3);
    for (const e of dated) expect(e.label).toBe("estimated");
  });

  it("the goods and service rules carry help129's timelines (used by M3-03 / M3-04)", () => {
    const from = at("2026-10-30T10:00:00Z");
    expect(holdRule("goods_delivered")?.estimate(from)?.at).toBe("2026-10-31T10:00:00.000Z");
    expect(holdRule("service_completed")?.estimate(from)?.at).toBe("2026-11-06T10:00:00.000Z");
    expect(holdRule("nope")).toBeNull();
  });

  it("advice appears only where a cited source carries it", () => {
    for (const row of HOLD_RULES) {
      if (row.advice === null) continue;
      expect(row.sources[row.advice.sourceIndex]?.quote).toContain(row.advice.quote);
    }
    expect(holdRule("payment_review")?.advice?.kind).toBe("dont_ship");
    expect(holdRule("dispute_hold")?.advice).toBeNull();
  });

  it("business days skip the weekend", () => {
    // Friday 30 Oct + 1 business day = Monday 2 Nov
    expect(addBusinessDays(at("2026-10-30T09:00:00Z"), 1)).toBe("2026-11-02T09:00:00.000Z");
  });
});

describe("sample scenarios are never derived (property over all reasons)", () => {
  it("has the three badged samples", () => {
    expect(SAMPLE_RULES.map((r) => r.id)).toEqual(["new_seller_21d", "reserve", "limitation"]);
    for (const r of SAMPLE_RULES) expect(r.sample).toBe(true);
  });

  it("no status × reason × dispute combination yields a sample row", () => {
    const sampleIds = new Set(SAMPLE_RULES.map((r) => r.id));
    const reasons = [
      ...new Set([
        ...HOLD_RULES.flatMap((r) => (r.appliesTo.kind === "reason" ? r.appliesTo.reasons : [])),
        ...SAMPLE_RULES.map((r) => r.id),
        "new_seller_21d",
        "RESERVE",
        "LIMITATION",
        "",
      ]),
    ];
    // plus pseudo-random strings (a fixed LCG, so a failure reproduces)
    let seed = 42;
    for (let i = 0; i < 200; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      reasons.push(seed.toString(36).toUpperCase());
    }
    const statuses = ["PENDING", "COMPLETED", "DECLINED", "REFUNDED", "FAILED", "pending"];
    const dispute = { disputeId: "PP-R-Z", status: "OPEN", sellerResponseDueDate: null };
    let derived = 0;
    for (const status of statuses) {
      for (const reason of reasons) {
        for (const d of [null, dispute]) {
          const h = deriveHold({ status, reason, updateTime: at("2026-10-26T00:00:00Z") }, d);
          if (h === null) continue;
          derived += 1;
          expect(sampleIds.has(h.estimateRuleId)).toBe(false);
          expect(h.type).not.toBe("sample");
          expect(holdRule(h.estimateRuleId)?.sample).toBe(false);
        }
      }
    }
    expect(derived).toBeGreaterThan(0);
  });
});

describe("hold machine (release edges, ADR 0017)", () => {
  it("PayPal's release reaches `released` from every state but released", () => {
    for (const s of HOLD_STATES) {
      const r = transitionHold(s, "capture_released");
      if (s === "released") expect(r.ok).toBe(false);
      else expect(r).toEqual({ ok: true, value: "released" });
    }
    expect(holdMachine.initial).toBe("open");
    expect(isHoldActive("released")).toBe(false);
    expect(isHoldActive("still_held")).toBe(true);
  });
});
