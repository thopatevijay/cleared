// Money for display (M4-03): PayPal's decimal string, formatted by Intl from the string itself, so an
// amount never passes through a float. PayPal's minor units win over Intl's (HUF, JPY, TWD: none).
// Indian grouping (1,00,000.00) comes from the hi-IN / en-IN locale data. Never converts currencies.
import { CURRENCY_EXPONENTS, isCurrencyCode } from "../currency.ts";
import { numberFormat } from "./intl-cache.ts";

/** `narrowSymbol` → "$120.00", `name` → "120.00 US dollars" (accessible name), `code` → "USD 120.00". */
export type MoneyDisplay = "narrowSymbol" | "name" | "code";

/** A signed decimal string ("-12.50" is a refund); nothing else reaches Intl. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
type DecimalString = `${number}`;
const isDecimal = (value: string): value is DecimalString => DECIMAL.test(value);

/**
 * `formatMoney("1234567.50", "INR", "hi-IN")` → "₹12,34,567.50". A value or currency Intl can't format is
 * shown as PayPal sent it (callers print the code beside it), never guessed.
 */
export function formatMoney(
  value: string,
  currency: string,
  locale: string,
  display: MoneyDisplay = "narrowSymbol",
  /** drop an all-zero fraction ("$420" for "420.00"): tight cells that link to the full amount */
  compact = false,
): string {
  if (!isDecimal(value)) return value;
  const whole = compact && /^-?\d+(?:\.0+)?$/.test(value);
  const digits = whole ? 0 : isCurrencyCode(currency) ? CURRENCY_EXPONENTS[currency] : undefined;
  try {
    return numberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: display,
      numberingSystem: "latn",
      ...(digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    }).format(value);
  } catch {
    return value;
  }
}

/**
 * PayPal's exchange rate as it sent it (a decimal string), e.g. "1 USD = 83.2510 INR". Display only: the
 * rate is never used to convert or sum (BL-01: the rate is not stored yet).
 */
export function formatExchangeRate(rate: string, from: string, to: string, locale: string): string {
  if (!isDecimal(rate)) return `1 ${from} = ${rate} ${to}`;
  const fraction = rate.split(".")[1]?.length ?? 0;
  const n = numberFormat(locale, {
    numberingSystem: "latn",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(rate);
  return `1 ${from} = ${n} ${to}`;
}
