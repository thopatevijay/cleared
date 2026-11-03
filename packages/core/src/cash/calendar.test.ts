// M3-05: the cash calendar's pure core. Days are resolved in the workspace zone (an instant late in the UTC
// day lands on the next day in Kolkata), the range is inclusive and capped at 92 days, totals are per day
// per currency and never summed across currencies, deadlines never count as cash, and every estimate
// carries its rule's first source.
import { describe, expect, it } from "vitest";
import {
  addDecimal,
  buildCashCalendar,
  CashRangeSchema,
  defaultCashRange,
  localDay,
  type CashDisputeInput,
  type CashHoldInput,
} from "./calendar.ts";

const H = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const review: CashHoldInput = {
  id: H(1),
  amount: { value: "64.00", currency: "USD" },
  state: "open",
  reason: "PENDING_REVIEW",
  ruleId: "payment_review",
  estimatedReleaseAt: "2026-11-04T20:00:00.000Z", // 5 Nov 01:30 in Kolkata
  releasedAt: null,
};
const complaint: CashHoldInput = {
  id: H(2),
  amount: { value: "120.00", currency: "USD" },
  state: "open",
  reason: "BUYER_COMPLAINT",
  ruleId: "dispute_hold",
  estimatedReleaseAt: null,
  releasedAt: null,
};
const released: CashHoldInput = {
  id: H(3),
  amount: { value: "420.00", currency: "USD" },
  state: "released",
  reason: "PENDING_REVIEW",
  ruleId: "payment_review",
  estimatedReleaseAt: "2026-11-03T10:00:00.000Z",
  releasedAt: "2026-11-05T06:00:00.000Z",
};
const service: CashHoldInput = {
  id: H(4),
  amount: { value: "15.50", currency: "EUR" },
  state: "filed",
  reason: "OTHER",
  ruleId: "service_completed",
  estimatedReleaseAt: "2026-11-05T09:00:00.000Z",
  releasedAt: null,
};
const dispute: CashDisputeInput = {
  id: H(10),
  status: "WAITING_FOR_SELLER_RESPONSE",
  dueDate: "2026-11-09T07:00:00.000Z",
  amount: { value: "120.00", currency: "USD" },
};

const build = (o: Partial<Parameters<typeof buildCashCalendar>[0]> = {}) =>
  buildCashCalendar({
    range: { from: "2026-11-01", to: "2026-11-30" },
    timeZone: "Asia/Kolkata",
    holds: [review, complaint, released, service],
    disputes: [dispute],
    heldNow: [
      { value: "15.50", currency: "EUR" },
      { value: "184.00", currency: "USD" },
    ],
    ...o,
  });

describe("cash calendar range", () => {
  it("accepts an inclusive range up to 92 days", () => {
    expect(CashRangeSchema.safeParse({ from: "2026-11-01", to: "2027-01-31" }).success).toBe(true);
    expect(CashRangeSchema.safeParse({ from: "2026-11-01", to: "2026-11-01" }).success).toBe(true);
  });
  it("refuses 93 days, a reversed range, offsets, times and extra keys", () => {
    expect(CashRangeSchema.safeParse({ from: "2026-11-01", to: "2027-02-01" }).success).toBe(false);
    expect(CashRangeSchema.safeParse({ from: "2026-11-02", to: "2026-11-01" }).success).toBe(false);
    expect(CashRangeSchema.safeParse({ from: "2026-11-01T00:00:00Z", to: "2026-11-02" }).success).toBe(false);
    expect(CashRangeSchema.safeParse({ from: "2026-11-01", to: "2026-11-02", tz: "UTC" }).success).toBe(
      false,
    );
    expect(CashRangeSchema.safeParse({ from: "2026-13-01", to: "2026-11-02" }).success).toBe(false);
  });
  it("defaults to the first of the month in the workspace zone, then 92 days", () => {
    // 31 Oct 20:00 UTC is already 1 Nov in Kolkata
    expect(defaultCashRange("2026-10-31T20:00:00.000Z", "Asia/Kolkata")).toEqual({
      from: "2026-11-01",
      to: "2027-01-31",
    });
    expect(defaultCashRange("2026-10-31T20:00:00.000Z", "America/Los_Angeles").from).toBe("2026-10-01");
  });
  it("resolves a day in the zone; an unknown zone falls back to UTC", () => {
    expect(localDay("2026-11-04T20:00:00.000Z", "Asia/Kolkata")).toBe("2026-11-05");
    expect(localDay("2026-11-04T20:00:00.000Z", "America/Los_Angeles")).toBe("2026-11-04");
    expect(localDay("2026-11-04T20:00:00.000Z", "Not/AZone")).toBe("2026-11-04");
  });
});

describe("cash calendar events", () => {
  it("one event per kind, sorted by day, each with the right ref, label inputs and source", () => {
    const c = build();
    expect(c.events.map((e) => [e.kind, e.date, e.amount.value, e.estimated, e.ref.type])).toEqual([
      ["estimated_release", "2026-11-05", "64.00", true, "hold"],
      ["service_completed_due", "2026-11-05", "15.50", true, "hold"],
      ["released", "2026-11-05", "420.00", false, "hold"],
      ["dispute_deadline", "2026-11-09", "120.00", false, "dispute"],
    ]);
    const est = c.events[0];
    expect(est?.ruleId).toBe("payment_review");
    expect(est?.source?.url).toMatch(/^https:\/\/[a-z.]*paypal\.com\//);
    expect(c.events[1]?.source?.title).toBeTruthy();
    expect(c.events[2]).toMatchObject({ ruleId: null, source: null, at: "2026-11-05T06:00:00.000Z" });
    expect(c.events[3]).toMatchObject({
      id: `dispute_deadline:${H(10)}`,
      detail: "WAITING_FOR_SELLER_RESPONSE",
    });
    expect(new Set(c.events.map((e) => e.id)).size).toBe(c.events.length);
  });

  it("a hold with no timeline is listed under no estimate, not on a day", () => {
    const c = build();
    expect(c.noEstimate).toEqual([
      {
        holdId: H(2),
        amount: { value: "120.00", currency: "USD" },
        reason: "BUYER_COMPLAINT",
        ruleId: "dispute_hold",
      },
    ]);
    expect(c.events.some((e) => e.ref.id === H(2))).toBe(false);
  });

  it("totals per day per currency: estimated and released apart, deadlines never counted", () => {
    expect(build().totals).toEqual([
      { date: "2026-11-05", currency: "EUR", estimated: "15.50", released: "0", count: 1 },
      { date: "2026-11-05", currency: "USD", estimated: "64.00", released: "420.00", count: 2 },
    ]);
    const two = build({
      holds: [review, { ...review, id: H(5), amount: { value: "0.05", currency: "USD" } }],
    });
    expect(two.totals).toEqual([
      { date: "2026-11-05", currency: "USD", estimated: "64.05", released: "0", count: 2 },
    ]);
  });

  it("only the range, in the workspace zone (inclusive bounds)", () => {
    expect(build({ range: { from: "2026-11-06", to: "2026-11-09" } }).events.map((e) => e.kind)).toEqual([
      "dispute_deadline",
    ]);
    // in Los Angeles the review estimate and the release (06:00 UTC) are still 4 Nov
    const la = build({ timeZone: "America/Los_Angeles", range: { from: "2026-11-04", to: "2026-11-04" } });
    expect(la.events.map((e) => e.kind)).toEqual(["estimated_release", "released"]);
    expect(build({ range: { from: "2026-12-01", to: "2026-12-31" } }).events).toEqual([]);
  });

  it("a resolved dispute, a dispute without a due date or amount, and a release without a time add nothing", () => {
    const c = build({
      holds: [{ ...released, releasedAt: null }],
      disputes: [
        { ...dispute, status: "RESOLVED" },
        { ...dispute, id: H(11), dueDate: null },
        { ...dispute, id: H(12), amount: null },
      ],
    });
    expect(c.events).toEqual([]);
    expect(c.totals).toEqual([]);
    expect(c.heldNow).toHaveLength(2);
  });
});

describe("addDecimal", () => {
  it("adds exactly at the longer scale", () => {
    expect(addDecimal("0", "64.00")).toBe("64.00");
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
    expect(addDecimal("999.99", "0.01")).toBe("1000.00");
    expect(addDecimal("5", "7")).toBe("12");
    expect(addDecimal("1000", "0.5")).toBe("1000.5");
  });
});
