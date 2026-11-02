// The page header (landing and dashboard): skip link (first Tab stop), the text wordmark, the language
// switch, and on signed-in pages the notification bell (M3-08). Sticky, 56 px.
import { useTranslations } from "next-intl";
import { LanguageSwitch } from "./LanguageSwitch.tsx";
import { NotificationBell } from "./notifications/NotificationBell.tsx";

export function SiteHeader({
  skipTo,
  skipLabel,
  signedIn = false,
}: {
  skipTo: string;
  skipLabel: "skipMain" | "skipPayments";
  /** pages behind a session show the bell */
  signedIn?: boolean;
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
          <div className="flex items-center gap-2">
            {signedIn ? <NotificationBell /> : null}
            <LanguageSwitch />
          </div>
        </div>
      </header>
    </>
  );
}
