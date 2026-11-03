// M3-05: the engine-neutral `CashCalendar` interface (ADR 0016). Engines (today only Bryntum) and our own
// list view take exactly these props; nothing here names a library. Days are `YYYY-MM-DD` already resolved
// in the workspace zone (`tz`), and are rendered as all-day dates: never shifted by the browser's zone.
import type { CashDayTotal, CashEvent } from "@cleared/core";

export type CashView = "list" | "month";

export interface CashCalendarProps {
  readonly events: readonly CashEvent[];
  readonly totals: readonly CashDayTotal[];
  /** BCP 47 for Intl ("en-IN", "hi-IN") */
  readonly locale: string;
  /** the workspace's IANA zone (labels only; every `date` is already in it) */
  readonly tz: string;
  /** click, tap, Enter or Space on an event */
  readonly onSelect: (event: CashEvent) => void;
  readonly view: CashView;
  /** `YYYY-MM-DD` the view opens on (today in the workspace zone) */
  readonly initialDate: string;
  /** month view: the visible range moved (`YYYY-MM-DD`, inclusive) */
  readonly onRangeChange?: (from: string, to: string) => void;
  /** month view: a day was selected (its events show beside or below the grid) */
  readonly onDaySelect?: (date: string) => void;
  /** month view: the selected day (`YYYY-MM-DD`), marked in the grid */
  readonly selectedDay?: string | null;
  /** month view: the engine has rendered (the day prompt only makes sense then) */
  readonly onEngineReady?: () => void;
}

/** Where selecting an event goes: the hold detail or the dispute detail. */
export function eventHref(e: Pick<CashEvent, "ref">): string {
  return e.ref.type === "hold" ? `/holds/${e.ref.id}` : `/disputes/${e.ref.id}`;
}

/** A day as an instant at noon UTC, for Intl formatting with `timeZone: "UTC"` (never shifts a day). */
export const dayInstant = (date: string): string => `${date}T12:00:00.000Z`;
