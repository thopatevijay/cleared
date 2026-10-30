import { describe, expect, it } from "vitest";
import {
  CURRENCY_EXPONENTS,
  formatMoney,
  fromMinorUnits,
  isCurrencyCode,
  MoneySchema,
  moneyFromPayPal,
  moneyToPayPal,
  parseMoney,
  toMinorUnits,
  type Money,
} from "../src/index.ts";

function must(value: string, currency: string): Money {
  const r = parseMoney(value, currency);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("Money", () => {
  it.each([
    ["120.00", "USD", 12000n],
    ["1000", "JPY", 1000n],
    ["0.10", "INR", 10n],
  ])("round-trips %s %s losslessly", (value, currency, minor) => {
    const m = must(value, currency);
    expect(formatMoney(m)).toBe(value);
    expect(toMinorUnits(m)).toBe(minor);
    expect(fromMinorUnits(minor, m.currency)).toEqual(m);
    expect(moneyToPayPal(m)).toEqual({ currency_code: currency, value });
  });

  it("keeps values a float would corrupt", () => {
    expect(formatMoney(must("90071992547409.93", "USD"))).toBe("90071992547409.93");
    const a = toMinorUnits(must("0.10", "USD"));
    const b = toMinorUnits(must("0.20", "USD"));
    expect(formatMoney(fromMinorUnits(a + b, "USD"))).toBe("0.30");
  });

  it("canonicalises: pads to the exponent, strips leading zeros", () => {
    expect(must("0.1", "INR").amount).toBe("0.10");
    expect(must("7", "USD").amount).toBe("7.00");
    expect(must("007.50", "EUR").amount).toBe("7.50");
    expect(must("0", "JPY").amount).toBe("0");
    expect(fromMinorUnits(5n, "USD").amount).toBe("0.05");
  });

  it.each([
    ["1.5", "JPY", "too many decimal places for the currency"],
    ["1.005", "USD", "too many decimal places for the currency"],
    ["-1.00", "USD", "not a non-negative decimal"],
    ["1e3", "USD", "not a non-negative decimal"],
    ["", "USD", "not a non-negative decimal"],
    ["1.", "USD", "not a non-negative decimal"],
    ["1.00", "XYZ", "unsupported currency"],
  ])("rejects %j %s (never rounds)", (value, currency, message) => {
    const r = parseMoney(value, currency);
    expect(r).toEqual({ ok: false, error: { code: "invalid_money", message, details: { value, currency } } });
  });

  it("refuses negative minor units", () => {
    expect(() => fromMinorUnits(-1n, "USD")).toThrow(RangeError);
  });

  it("has the exponent table: JPY 0, INR/USD 2", () => {
    expect(CURRENCY_EXPONENTS.JPY).toBe(0);
    expect(CURRENCY_EXPONENTS.INR).toBe(2);
    expect(CURRENCY_EXPONENTS.USD).toBe(2);
    expect(isCurrencyCode("USD")).toBe(true);
    expect(isCurrencyCode("toString")).toBe(false);
  });

  it("reads PayPal's wire shape", () => {
    expect(moneyFromPayPal({ currency_code: "USD", value: "42.00" })).toEqual({
      ok: true,
      value: { amount: "42.00", currency: "USD" },
    });
  });

  it("MoneySchema accepts only canonical amounts", () => {
    expect(MoneySchema.safeParse({ amount: "42.00", currency: "USD" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: "42.0", currency: "USD" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: "42", currency: "XYZ" }).success).toBe(false);
  });
});
