// Amounts and times for the UI (README "Numbers, currency and dates"): Intl only, Latin digits, the ISO
// code beside the symbol, workspace time zone. Never converts or sums across currencies.
import type { Amount } from "@cleared/core";

export interface FormattedAmount {
  /** "$120.00" (narrow symbol) */
  readonly text: string;
  /** "USD" */
  readonly code: string;
  /** "120.00 US dollars" (accessible name) */
  readonly spoken: string;
}

function numberFormat(locale: string, currency: string, display: "narrowSymbol" | "name"): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: display,
    numberingSystem: "latn",
  });
}

export function formatAmount(locale: string, a: Amount): FormattedAmount {
  const n = Number(a.value);
  try {
    return {
      text: numberFormat(locale, a.currency, "narrowSymbol").format(n),
      code: a.currency,
      spoken: numberFormat(locale, a.currency, "name").format(n),
    };
  } catch {
    // A currency code Intl does not know: show PayPal's value verbatim rather than guess.
    return { text: a.value, code: a.currency, spoken: `${a.value} ${a.currency}` };
  }
}

/** "30 Oct 2026, 6:12 pm IST" in the workspace time zone. */
export function formatTime(locale: string, iso: string, timeZone: string): string {
  const d = new Date(iso);
  try {
    // dateStyle/timeStyle can't be combined with timeZoneName, so the fields are listed.
    return new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
      numberingSystem: "latn",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(d);
  }
}

export type StatusKey = "completed" | "held" | "refunded" | "failed" | "info" | "resolved";

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
