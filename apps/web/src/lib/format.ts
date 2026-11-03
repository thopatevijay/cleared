// Amounts and times for the UI (README "Numbers, currency and dates"): Intl only, Latin digits, the ISO
// code beside the symbol, workspace time zone. Never converts or sums across currencies.
import { formatDateTime, formatMoney, type Amount } from "@cleared/core";

export interface FormattedAmount {
  /** "$120.00" (narrow symbol) */
  readonly text: string;
  /** "USD" */
  readonly code: string;
  /** "120.00 US dollars" (accessible name) */
  readonly spoken: string;
}

/**
 * PayPal's decimal string through core `formatMoney` (M4-03): never a float. A currency code Intl does not
 * know shows PayPal's value verbatim rather than a guess.
 */
export function formatAmount(locale: string, a: Amount): FormattedAmount {
  const text = formatMoney(a.value, a.currency, locale);
  return {
    text,
    code: a.currency,
    spoken: text === a.value ? `${a.value} ${a.currency}` : formatMoney(a.value, a.currency, locale, "name"),
  };
}

/** "30 Oct 2026, 6:12 pm IST" (HI: 24 h) in the workspace time zone: core `formatDateTime`. */
export function formatTime(locale: string, iso: string, timeZone: string): string {
  return formatDateTime(iso, timeZone, locale);
}

export type StatusKey = "completed" | "held" | "refunded" | "failed" | "info" | "resolved" | "dispute";

/**
 * PayPal capture status → badge (components.md "Status badge"). Unknown or unmapped values (e.g.
 * `REVERSED`) get the neutral `info` badge with PayPal's raw value beside it: no invented state.
 */
export function captureStatusKey(status: string): StatusKey {
  switch (status) {
    case "COMPLETED":
      return "completed";
    case "PENDING":
      return "held";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "refunded";
    case "DECLINED":
    case "FAILED":
      return "failed";
    default:
      return "info";
  }
}

/** "By attention" (components.md): held → completed (newest first, as given) → refunded / failed / other. */
export function attentionRank(status: string): number {
  const key = captureStatusKey(status);
  return key === "held" ? 0 : key === "completed" ? 1 : 2;
}

/** "14:01:12 IST": an audit entry's time in the workspace time zone, with seconds (audit-log.md). */
export function formatClock(locale: string, iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "short",
      numberingSystem: "latn",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** The calendar day in the workspace time zone: `2026-10-30` (grouping key). */
export function dayKey(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "29 Oct" in the workspace time zone (M3-01 estimated dates); `long` → "29 October 2026" (names). */
export function formatDate(locale: string, iso: string, timeZone: string, long = false): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: long ? "long" : "short",
      ...(long ? { year: "numeric" as const } : {}),
      timeZone,
      numberingSystem: "latn",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "Fri 30 Oct" (a day group's heading). */
export function formatDay(locale: string, iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone,
      numberingSystem: "latn",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** Whole days (≥ 24 h left) or hours (under 24 h) until `iso`, never below 0. */
export function countdown(nowMs: number, iso: string): { unit: "days" | "hours"; n: number } {
  const left = Math.max(0, new Date(iso).getTime() - nowMs);
  const hours = Math.floor(left / 3_600_000);
  return hours >= 24 ? { unit: "days", n: Math.floor(hours / 24) } : { unit: "hours", n: hours };
}

/** "2.4 MB" / "126 KB": a file size (decimal units, as PayPal states its limits). */
export function formatBytes(locale: string, bytes: number): string {
  const nf = (n: number, d: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: d, numberingSystem: "latn" }).format(n);
  if (bytes >= 1_000_000) return `${nf(bytes / 1_000_000, 1)} MB`;
  return `${nf(Math.max(1, Math.round(bytes / 1_000)), 0)} KB`;
}
