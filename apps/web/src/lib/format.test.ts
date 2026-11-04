import { describe, expect, it } from "vitest";
import {
  attentionRank,
  captureStatusKey,
  formatAmount,
  formatAmountList,
  formatBytes,
  formatTime,
} from "./format.ts";

describe("formatBytes", () => {
  it("one decimal in MB, whole KB, and never rounds a file under the 10 MB limit up to 10 MB", () => {
    expect(formatBytes("en-IN", 2_400_000)).toBe("2.4 MB");
    expect(formatBytes("en-IN", 126_400)).toBe("126 KB");
    expect(formatBytes("en-IN", 9_990_000)).toBe("9.99 MB");
    expect(formatBytes("en-IN", 9_999_999)).toBe("9.99 MB");
    expect(formatBytes("en-IN", 9_940_000)).toBe("9.9 MB");
    expect(formatBytes("en-IN", 10_000_000)).toBe("10 MB");
    expect(formatBytes("hi-IN", 9_990_000)).toBe("9.99 MB");
  });
});

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

describe("formatAmountList", () => {
  const usd = { value: "120", currency: "USD" };
  const inr = { value: "5000", currency: "INR" };
  const eur = { value: "15", currency: "EUR" };

  it("EN: one amount alone, two with 'and', three with commas and 'and'; never '+'", () => {
    expect(formatAmountList("en-IN", [usd])).toBe("$120.00\u00a0USD");
    expect(formatAmountList("en-IN", [usd, inr])).toBe("$120.00\u00a0USD and ₹5,000.00\u00a0INR");
    expect(formatAmountList("en-IN", [eur, usd, inr])).toBe(
      "€15.00\u00a0EUR, $120.00\u00a0USD and ₹5,000.00\u00a0INR",
    );
  });

  it("HI: the Hindi conjunction 'और', Latin digits", () => {
    const hi = "hi-IN-u-nu-latn";
    expect(formatAmountList(hi, [usd])).toBe("$120.00\u00a0USD");
    expect(formatAmountList(hi, [usd, inr])).toBe("$120.00\u00a0USD और ₹5,000.00\u00a0INR");
    expect(formatAmountList(hi, [eur, usd, inr])).toBe(
      "€15.00\u00a0EUR, $120.00\u00a0USD, और ₹5,000.00\u00a0INR",
    );
  });

  it("each figure keeps its code on the same line (no-break space)", () => {
    expect(formatAmountList("en-IN", [usd])).not.toMatch(/\$120\.00 USD/);
  });

  it("no amounts: an empty string (callers show their own zero copy)", () => {
    expect(formatAmountList("en-IN", [])).toBe("");
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
