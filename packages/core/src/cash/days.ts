// Calendar-day arithmetic for the cash calendar, without zod (M4-08): the calendar screen and its Bryntum
// view use these in the browser. calendar.ts re-exports them.

export const DAY_MS = 86_400_000;

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `YYYY-MM-DD` plus `n` days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The calendar day of `iso` in `timeZone` (`YYYY-MM-DD`); an unknown zone falls back to UTC. */
export function localDay(iso: string, timeZone: string): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  try {
    return fmt(timeZone).format(new Date(iso));
  } catch {
    return fmt("UTC").format(new Date(iso));
  }
}
