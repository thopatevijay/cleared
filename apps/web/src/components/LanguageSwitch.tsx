"use client";
// Language switch (components.md): two links to the same route under /en and /hi. The current option is
// marked with aria-current plus an underline and bold (never colour alone); each option carries `lang`.
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Link, usePathname } from "../i18n/navigation.ts";
import { routing } from "../i18n/routing.ts";

export function LanguageSwitch() {
  const t = useTranslations("common");
  const current = useLocale();
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const href = query ? `${pathname}?${query}` : pathname;
  return (
    <nav aria-label={t("language")}>
      <ul className="flex items-center gap-1">
        {routing.locales.map((l) => {
          const active = l === current;
          return (
            <li key={l}>
              <Link
                href={href}
                locale={l}
                lang={l}
                hrefLang={l}
                aria-current={active ? "true" : undefined}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-sm ${
                  active
                    ? "border-b-2 border-accent font-bold text-text"
                    : "text-accent hover:bg-surface-sunken"
                }`}
              >
                <span aria-hidden="true">{l === "en" ? t("langEnShort") : t("langHiShort")}</span>
                <span className="sr-only">{l === "en" ? t("langEn") : t("langHi")}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
