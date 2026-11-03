// Dates for display (M4-03): instants are stored in UTC and shown in the workspace's IANA time zone, with
// the zone's short name. Latin digits always; Hindi uses the 24-hour clock (no Latin "am"/"pm" inside
// Devanagari text: BL-01 6569282428). Intl only.

const isHindi = (locale: string): boolean => locale.toLowerCase().startsWith("hi");

/** "30 Oct 2026, 6:12 pm IST" (en-IN) / "30 अक्टू॰ 2026, 18:12 IST" (hi-IN). An unknown zone falls back to UTC. */
export function formatDateTime(utcIso: string, timeZone: string, locale: string): string {
  const d = new Date(utcIso);
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    numberingSystem: "latn",
    ...(isHindi(locale) ? { hourCycle: "h23" as const } : {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(d);
  }
}

/** The same instant in UTC: the tooltip beside every deadline shown in the seller's zone. */
export function formatUtc(utcIso: string, locale: string): string {
  return formatDateTime(utcIso, "UTC", locale);
}

/** Whole days from 24 h up, whole hours below (as the deadline badges count), signed: past is negative. */
export function relativeParts(utcIso: string, nowMs: number): { unit: "day" | "hour"; n: number } {
  const diff = new Date(utcIso).getTime() - nowMs;
  const hours = Math.trunc(diff / 3_600_000);
  return Math.abs(hours) >= 24 ? { unit: "day", n: Math.trunc(hours / 24) } : { unit: "hour", n: hours };
}

/** "in 3 days" / "in 5 hours" / "2 hours ago" ("3 दिन में"), from `nowMs`. */
export function formatRelative(utcIso: string, nowMs: number, locale: string): string {
  const { unit, n } = relativeParts(utcIso, nowMs);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(n, unit);
}
