// The page header (landing and dashboard): skip link (first Tab stop), the text wordmark, the language
// switch. Sticky, 56 px.
import { useTranslations } from "next-intl";
import { LanguageSwitch } from "./LanguageSwitch.tsx";

export function SiteHeader({
  skipTo,
  skipLabel,
}: {
  skipTo: string;
  skipLabel: "skipMain" | "skipPayments";
}) {
  const t = useTranslations("common");
  return (
    <>
      <a
        href={`#${skipTo}`}
        className="sr-only z-[var(--z-toast)] rounded-md bg-surface px-4 py-3 text-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t(skipLabel)}
      </a>
      <header className="sticky top-0 z-[var(--z-sticky)] border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4">
          <span className="font-[family-name:var(--font-atkinson)] text-xl leading-none font-bold" lang="en">
            {t("wordmark")}
          </span>
          <LanguageSwitch />
        </div>
      </header>
    </>
  );
}
