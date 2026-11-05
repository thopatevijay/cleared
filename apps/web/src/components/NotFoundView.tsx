// The app-level 404 (docs/design/screens/not-found.md, BL-01 6649566240): the public shell, one h1, one
// sentence, and one way home. No session, no workspace data, no correlation ID.
import { Compass } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { SiteHeader } from "./SiteHeader.tsx";
import { LandingFooter } from "./SiteFooter.tsx";

export function NotFoundView() {
  const t = useTranslations("notFound");
  const locale = useLocale();
  return (
    <>
      <title>{t("metaTitle")}</title>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-[640px] flex-col items-start gap-4 px-4 py-8"
        data-testid="not-found-page"
      >
        <Compass aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p>{t("body")}</p>
        <a
          href={`/${locale}`}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-5 py-2 font-semibold text-on-accent hover:bg-accent-hover md:min-h-11 md:w-auto"
        >
          {t("home")}
        </a>
      </main>
      <LandingFooter />
    </>
  );
}
