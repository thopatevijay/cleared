import { describe, expect, it } from "vitest";
import { attentionRank, captureStatusKey, formatAmount, formatTime } from "./format.ts";

describe("formatAmount", () => {
  it("narrow symbol + ISO code, spoken name, Latin digits in Hindi", () => {
    expect(formatAmount("en-IN", { value: "120.00", currency: "USD" })).toEqual({
      text: "$120.00",
      code: "USD",
      spoken: "120.00 US dollars",
    });
    expect(formatAmount("en-IN", { value: "100000", currency: "INR" }).text).toBe("₹1,00,000.00");
    expect(formatAmount("hi-IN-u-nu-latn", { value: "42.5", currency: "USD" }).text).toMatch(/^\$42\.50$/);
  });

  it("an unknown currency code is shown verbatim", () => {
    expect(formatAmount("en-IN", { value: "1.00", currency: "ZZ1" })).toEqual({
      text: "1.00",
      code: "ZZ1",
      spoken: "1.00 ZZ1",
    });
  });
});

describe("formatTime", () => {
  it("uses the workspace time zone", () => {
    expect(formatTime("en-IN", "2026-10-30T12:00:00.000Z", "Asia/Kolkata")).toMatch(
      /30 Oct 2026, 5:30\s?pm/i,
    );
    expect(formatTime("en-IN", "2026-10-30T12:00:00.000Z", "Not/AZone")).toMatch(/30 Oct 2026/);
  });
});

describe("status mapping", () => {
  it.each([
    ["COMPLETED", "completed"],
    ["PENDING", "held"],
    ["REFUNDED", "refunded"],
    ["PARTIALLY_REFUNDED", "refunded"],
    ["DECLINED", "failed"],
    ["FAILED", "failed"],
    ["REVERSED", "info"],
    ["SOMETHING_NEW", "info"],
  ])("%s → %s", (status, key) => {
    expect(captureStatusKey(status)).toBe(key);
  });

  it("held sorts before completed before the rest", () => {
    expect(["COMPLETED", "REFUNDED", "PENDING"].sort((a, b) => attentionRank(a) - attentionRank(b))).toEqual([
      "PENDING",
      "COMPLETED",
      "REFUNDED",
    ]);
  });
});
