// The dispute screens' plain helpers, without zod (M4-08): components that render import these, and only
// the response parsers (lib/schemas.ts, loaded on demand) need dispute-view.ts's schemas.
import type { Outcome } from "./dispute-view.ts";

export const NOTES_MAX = 2000;
/** The count is announced at this many characters and above the limit, never on every keystroke. */
export const NOTES_WARN_AT = 1900;

/** The draft fingerprint: the first 8 hex characters of `payload_sha256`. */
export const fingerprint = (sha: string): string => sha.slice(0, 8);

/** Unicode code points, as PayPal counts the 2000-character notes limit. */
export function codePointCount(s: string): number {
  return Array.from(s).length;
}

/** RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL: "you keep the money (PayPal covered the case)". */
export function isPaypalCoveredPayout(o: Outcome | null): boolean {
  return o?.outcome_code === "RESOLVED_WITH_PAYOUT" && o.outcome_reason === "REPRESENTED_BY_PAYPAL";
}
