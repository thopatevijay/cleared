// M4-03 AC 3: display money from PayPal's decimal string in en-US, en-IN and hi-IN, never through a float.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatExchangeRate,
  formatMoney,
  fromMinorUnits,
  moneyToDecimal,
  parseMoney,
  toMinorUnits,
} from "../../src/index.ts";

const LOCALES = ["en-US", "en-IN", "hi-IN"] as const;
type Row = readonly [value: string, currency: string, expected: Record<(typeof LOCALES)[number], string>];

const ROWS: readonly Row[] = [
  ["120.00", "USD", { "en-US": "$120.00", "en-IN": "$120.00", "hi-IN": "$120.00" }],
  ["1234.50", "EUR", { "en-US": "€1,234.50", "en-IN": "€1,234.50", "hi-IN": "€1,234.50" }],
  // lakh grouping in the Indian locales
  ["1234567.89", "INR", { "en-US": "₹1,234,567.89", "en-IN": "₹12,34,567.89", "hi-IN": "₹12,34,567.89" }],
  // JPY, HUF: PayPal takes no decimals
  ["1500", "JPY", { "en-US": "¥1,500", "en-IN": "¥1,500", "hi-IN": "¥1,500" }],
  ["2500", "HUF", { "en-US": "Ft\u00a02,500", "en-IN": "Ft\u00a02,500", "hi-IN": "Ft\u00a02,500" }],
  // a refund
  ["-12.50", "USD", { "en-US": "-$12.50", "en-IN": "-$12.50", "hi-IN": "-$12.50" }],
];

describe("formatMoney", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [value, currency, expected] of ROWS) {
    for (const locale of LOCALES) {
      it(`${value} ${currency} in ${locale} → ${expected[locale]}`, () => {
        expect(formatMoney(value, currency, locale)).toBe(expected[locale]);
      });
    }
  }

  it("names the currency for screen readers, in Hindi too", () => {
    expect(formatMoney("120.00", "USD", "en-US", "name")).toBe("120.00 US dollars");
    expect(formatMoney("1234567.89", "INR", "hi-IN", "name")).toBe("12,34,567.89 भारतीय रुपए");
    expect(formatMoney("1500", "JPY", "en-IN", "name")).toBe("1,500 Japanese yen");
  });

  it("keeps a value a float would corrupt (Number gives …409.94)", () => {
    expect(Number("90071992547409.93").toFixed(2)).toBe("90071992547409.94"); // the corruption avoided
    expect(formatMoney("90071992547409.93", "USD", "en-US")).toBe("$90,071,992,547,409.93");
    expect(formatMoney("90071992547409.93", "USD", "hi-IN")).toBe("$9,00,71,99,25,47,409.93");
  });

  it('"0.10" + "0.20" is summed in minor units and formatted from the string: $0.30, never 0.30000000000000004', () => {
    const a = parseMoney("0.10", "USD");
    const b = parseMoney("0.20", "USD");
    if (!a.ok || !b.ok) throw new Error("parse");
    const sum = moneyToDecimal(fromMinorUnits(toMinorUnits(a.value) + toMinorUnits(b.value), "USD"));
    // `format` is a bound getter: wrap the function it returns and record what Intl receives
    const proto = Intl.NumberFormat.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "format");
    if (original?.get === undefined) throw new Error("no format getter");
    const received: unknown[] = [];
    Object.defineProperty(proto, "format", {
      configurable: true,
      get(this: Intl.NumberFormat) {
        const real = original.get?.call(this) as (v: number | bigint | `${number}`) => string;
        return (v: number | bigint | `${number}`): string => {
          received.push(v);
          return real(v);
        };
      },
    });
    try {
      expect(formatMoney(sum, "USD", "en-US")).toBe("$0.30");
    } finally {
      Object.defineProperty(proto, "format", original);
    }
    // Intl received PayPal's string, not a number
    expect(received).toEqual(["0.30"]);
  });

  it("shows anything that is not a decimal as PayPal sent it, never guessed", () => {
    expect(formatMoney("12.5x", "USD", "en-US")).toBe("12.5x USD");
    expect(formatMoney("1e3", "USD", "en-US")).toBe("1e3 USD");
    expect(formatMoney("10.00", "ZZZ1", "en-US")).toBe("10.00 ZZZ1");
  });
});

describe("formatExchangeRate", () => {
  it("prints PayPal's rate with its own digits", () => {
    expect(formatExchangeRate("83.2510", "USD", "INR", "hi-IN")).toBe("1 USD = 83.2510 INR");
    expect(formatExchangeRate("0.0119", "INR", "USD", "en-US")).toBe("1 INR = 0.0119 USD");
    expect(formatExchangeRate("1500.5", "EUR", "HUF", "en-US")).toBe("1 EUR = 1,500.5 HUF");
  });
});
