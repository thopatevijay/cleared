// Locale from `Accept-Language` and a client-supplied IANA time zone (M1-05).
import type { Locale } from "@cleared/core";

export const DEFAULT_TIMEZONE = "UTC";

/** The highest-weighted supported language (en, hi) in `Accept-Language`; `en` when none. */
export function localeFrom(acceptLanguage: string | null): Locale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { lang: tag.toLowerCase().split("-")[0] ?? "", weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  const hit = ranked.find((x) => x.lang === "en" || x.lang === "hi");
  return hit?.lang === "hi" ? "hi" : "en";
}

let zones: ReadonlySet<string> | undefined;

/**
 * True for an IANA zone in `Intl.supportedValuesOf('timeZone')`. That list holds canonical names only
 * (Node 24 lists `Asia/Calcutta`, not `Asia/Kolkata`, and has no `UTC`), so a name whose canonical
 * form is listed, or is UTC, is accepted too.
 */
export function isSupportedTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(tz)) return false;
  zones ??= new Set(Intl.supportedValuesOf("timeZone"));
  if (zones.has(tz)) return true;
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
    return canonical === "UTC" || zones.has(canonical);
  } catch {
    return false;
  }
}
