// next-intl routing (M1-07): every page lives under /en or /hi. The locales match core's LOCALES.
import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["en", "hi"],
  defaultLocale: "en",
  localePrefix: "always",
});

export type AppLocale = (typeof routing.locales)[number];

export function isAppLocale(v: string): v is AppLocale {
  return (routing.locales as readonly string[]).includes(v);
}

/** BCP 47 tag for Intl: Indian English / Hindi, Latin digits always (README "Numbers"). */
export function intlLocale(locale: AppLocale): string {
  return locale === "hi" ? "hi-IN-u-nu-latn" : "en-IN";
}
