// Money: a decimal string plus an ISO-4217 code, exactly as PayPal sends it ({ currency_code, value }).
// Lossless by construction: amounts are parsed into bigint minor units and formatted back from them.
// No floating-point arithmetic anywhere in this file (M1-01 AC; the gate greps for it).
import { z } from "zod";
import { domainError, type DomainError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Minor-unit exponents for PayPal's supported currencies (PayPal REST "Currency codes" reference).
 * HUF, JPY and TWD take no decimals at PayPal.
 */
export const CURRENCY_EXPONENTS = {
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 0,
  ILS: 2,
  INR: 2,
  JPY: 0,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TWD: 0,
  USD: 2,
} as const;
export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;
export const CURRENCY_CODES = Object.keys(CURRENCY_EXPONENTS) as [CurrencyCode, ...CurrencyCode[]];

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export interface Money {
  /** Canonical decimal string with exactly the currency's exponent digits after the point. */
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export function isCurrencyCode(raw: string): raw is CurrencyCode {
  return Object.hasOwn(CURRENCY_EXPONENTS, raw);
}

function invalid(message: string, value: string, currency: string): Result<never, DomainError> {
  return err(domainError("invalid_money", message, { value, currency }));
}

/** Parses a decimal amount losslessly. More fraction digits than the currency allows is an error, never rounded. */
export function parseMoney(value: string, currency: string): Result<Money, DomainError> {
  if (!isCurrencyCode(currency)) return invalid("unsupported currency", value, currency);
  const match = DECIMAL.exec(value);
  if (match === null) return invalid("not a non-negative decimal", value, currency);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = CURRENCY_EXPONENTS[currency];
  if (fraction.length > exponent) return invalid("too many decimal places for the currency", value, currency);
  const minor = BigInt(whole + fraction.padEnd(exponent, "0"));
  return ok(fromMinorUnits(minor, currency));
}

/** Integer minor units (cents, paise; yen are already minor). */
export function toMinorUnits(money: Money): bigint {
  return BigInt(money.amount.replace(".", ""));
}

export function fromMinorUnits(minor: bigint, currency: CurrencyCode): Money {
  if (minor < 0n) throw new RangeError("Money is non-negative");
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === 0) return { amount: minor.toString(), currency };
  const digits = minor.toString().padStart(exponent + 1, "0");
  const cut = digits.length - exponent;
  return { amount: `${digits.slice(0, cut)}.${digits.slice(cut)}`, currency };
}

/** The decimal string to send to PayPal. */
export function formatMoney(money: Money): string {
  return money.amount;
}

/** PayPal's wire shape. */
export const PayPalMoneySchema = z.object({ currency_code: z.string(), value: z.string() });
export type PayPalMoney = z.infer<typeof PayPalMoneySchema>;

export function moneyFromPayPal(raw: PayPalMoney): Result<Money, DomainError> {
  return parseMoney(raw.value, raw.currency_code);
}

export function moneyToPayPal(money: Money): PayPalMoney {
  return { currency_code: money.currency, value: formatMoney(money) };
}

/** Schema for Money inside our own payloads (events, contracts): the amount must already be canonical. */
export const MoneySchema = z
  .object({ amount: z.string(), currency: z.enum(CURRENCY_CODES) })
  .refine((m) => {
    const parsed = parseMoney(m.amount, m.currency);
    return parsed.ok && parsed.value.amount === m.amount;
  }, "amount is not a canonical decimal for its currency");
