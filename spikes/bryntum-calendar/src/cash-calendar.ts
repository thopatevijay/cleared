// The proposed `CashCalendar` contract (M0-09 → M3-05). Both spike implementations satisfy it.
// Plain data in, one callback out: no vendor type leaks through, so the product can swap
// Bryntum ↔ FullCalendar behind one component.

/** One expected release of held money, derived from a PENDING capture (M3-01). */
export type ReleaseEvent = {
  /** Stable id (the PayPal capture id); returned by `onSelect`. */
  id: string;
  /** Estimated release day, `YYYY-MM-DD`, in the workspace time zone (all-day event). */
  date: string;
  /** Decimal string exactly as PayPal returns it (never a float). */
  amount: string;
  /** ISO 4217 code, e.g. `USD`. */
  currency: string;
  /** Plain-text label (order ref / buyer alias). Rendered as text, never as HTML. */
  label: string;
  /** Release dates are estimates (domain rules); `true` shows the "estimated" badge. */
  estimated: boolean;
};

export type CashCalendarProps = {
  events: readonly ReleaseEvent[];
  /** BCP 47 locale from next-intl, e.g. `en-IN`, `hi-IN` (formats amounts and dates). */
  locale: string;
  /** IANA zone of the workspace, e.g. `Asia/Kolkata`. */
  timeZone: string;
  /** Month to open on, `YYYY-MM-DD`; defaults to the first event's month. */
  initialDate?: string;
  /** Called with `ReleaseEvent.id` when the seller activates an event (click or Enter). */
  onSelect?: (eventId: string) => void;
  /** Translated strings (next-intl), so the component itself holds no copy. */
  labels: { calendar: string; estimated: string };
  /** Colour scheme of the page; each implementation maps it to its own theme. */
  colorScheme?: "light" | "dark";
};

export function formatAmount(e: ReleaseEvent, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: e.currency }).format(Number(e.amount));
}

export function eventText(e: ReleaseEvent, locale: string): string {
  return `${formatAmount(e, locale)} · ${e.label}`;
}
