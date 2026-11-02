// Formatting for notification templates: money, a date in the seller's time zone, the time left to a
// deadline, and HTML escaping. Built-in Intl only (no I/O).
import type { Locale } from "../../accounts/workspace.ts";
import type { Money } from "../../money.ts";
import { toEpochMs, type Instant } from "../../time.ts";

// the web's `intlLocale` (apps/web/src/i18n/routing.ts): Indian English, Latin digits in HI
const intlLocale = (locale: Locale): string => (locale === "hi" ? "hi-IN-u-nu-latn" : "en-IN");

/** `$120.00 USD`: the symbol for recognition, the code so it is never ambiguous. */
export function formatAmount(money: Money | null, locale: Locale): string {
  if (money === null) return locale === "hi" ? "राशि" : "the payment";
  const n = new Intl.NumberFormat(locale === "hi" ? "en-IN" : "en-US", {
    style: "currency",
    currency: money.currency,
    currencyDisplay: "narrowSymbol",
  }).format(Number(money.amount));
  return `${n} ${money.currency}`;
}

export interface ZonedDate {
  /** `2 Nov` */
  readonly date: string;
  /** `23:59` */
  readonly time: string;
  /** `IST` / `GMT+5:30` / `UTC` */
  readonly tz: string;
}

export function zonedDate(at: Instant, locale: Locale, timeZone: string): ZonedDate {
  const d = new Date(toEpochMs(at));
  const lang = intlLocale(locale);
  const date = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", timeZone }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(d);
  const tz =
    new Intl.DateTimeFormat("en-IN", { timeZone, timeZoneName: "short" })
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  return { date, time, tz };
}

export type Remaining =
  { readonly unit: "days"; readonly n: number } | { readonly unit: "hours"; readonly n: number };

/**
 * The true time left at `now`: whole days from 48 h up, otherwise whole hours (at least 1), so a late run
 * never claims more time than there is.
 */
export function remaining(due: Instant, now: Instant): Remaining {
  const hours = (toEpochMs(due) - toEpochMs(now)) / 3_600_000;
  if (hours >= 48) return { unit: "days", n: Math.floor(hours / 24) };
  return { unit: "hours", n: Math.max(1, Math.floor(hours)) };
}

/** PayPal's reason code as words: `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` → `merchandise or service not received`. */
export function reasonWords(code: string | null): string {
  if (code === null || code === "") return "";
  return code.toLowerCase().replace(/_/g, " ");
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
