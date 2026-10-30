// next-intl request config (M1-07): the locale from the [locale] segment, its messages from
// apps/web/messages/<locale>.json.
import { getRequestConfig } from "next-intl/server";
import { isAppLocale, routing } from "./routing.ts";

export default getRequestConfig(async (params) => {
  // `next/root-params` would need [locale] to hold the root layout and its types exist only after a
  // build (.next/types), so CI's typecheck would see `any`. The proxy sets the locale for every page.
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above; BL-01 (M1-07)
  const requested = params.locale ?? (await params.requestLocale);
  const locale = requested !== undefined && isAppLocale(requested) ? requested : routing.defaultLocale;
  const messages = ((await import(`../../messages/${locale}.json`)) as { default: Record<string, unknown> })
    .default;
  return { locale, messages };
});
