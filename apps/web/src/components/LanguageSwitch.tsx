"use client";
// Language switch (components.md): two links to the same route under /en and /hi. The current option is
// marked with aria-current plus an underline and bold (never colour alone); each option carries `lang`.
// Rendered on the server (no useSearchParams, which would suspend it out of the first paint).
// M4-03: on signed-in pages the choice is also saved to `workspaces.locale` (PATCH /api/workspace), so AI
// explanations, emails and PDF labels follow it. The save never blocks the switch.
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "../i18n/navigation.ts";
import { routing } from "../i18n/routing.ts";
import { newKey, patchJson } from "../lib/api.ts";

export function LanguageSwitch({ persist = false }: { persist?: boolean }) {
  const t = useTranslations("common");
  const current = useLocale();
  const href = usePathname();
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
                onClick={() => {
                  if (persist && !active) void patchJson("/api/workspace", { locale: l }, newKey(), true);
                }}
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
