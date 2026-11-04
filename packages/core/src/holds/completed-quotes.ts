// What the guided Completed step shows in the browser, without zod (M4-08): PayPal support's quotes and the
// calendar date of an instant. completed.ts (which holds the zod schemas) re-exports them.
import { toEpochMs, type Instant } from "../instant.ts";

/** What PayPal support wrote to the owner (reply pasted 2026-10-26; docs/research RESEARCH.md log). */
export interface SupportQuote {
  readonly quote: string;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly from: "PayPal support";
}

export const PAYPAL_SUPPORT_QUOTES = {
  /** the web path the guided step follows */
  webPath: {
    quote:
      'For services or intangible items, you can update the order status to "Completed" in your Activity section to help release the hold.',
    date: "2026-10-26",
    from: "PayPal support",
  },
  /** why the API record is labelled "Effect on release unconfirmed" */
  apiUnconfirmed: {
    quote:
      'information confirming that an API-based "Completed" status update is functionally identical to the manual web update is not available.',
    date: "2026-10-26",
    from: "PayPal support",
  },
} as const satisfies Record<string, SupportQuote>;

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Instant, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(toEpochMs(at)));
}
