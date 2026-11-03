// Currency codes and exponents, without zod (M4-08): the money formatters run in the browser on every page,
// and importing money.ts there pulled zod into the shared first-load chunk. money.ts re-exports all of it.

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

export function isCurrencyCode(raw: string): raw is CurrencyCode {
  return Object.hasOwn(CURRENCY_EXPONENTS, raw);
}
