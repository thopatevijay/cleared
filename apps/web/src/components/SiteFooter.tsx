// Footers: the landing's sandbox disclaimer, and the dashboard's "you hold the keys" + audit-log link and
// (M4-03) the time-zone control, and (sweep M4) "Sign out".
import { useTranslations } from "next-intl";
import { Link } from "../i18n/navigation.ts";
import { SignOutButton } from "./SignOutButton.tsx";
import { TimeZoneControl } from "./TimeZoneControl.tsx";

export function LandingFooter() {
  const t = useTranslations("common");
  return (
    <footer className="border-t border-border py-6 text-sm text-text-muted">
      <p className="mx-auto max-w-[640px] px-4 xl:max-w-[1200px]">{t("footerSandbox")}</p>
    </footer>
  );
}

export function DashboardFooter({ current = false }: { current?: boolean }) {
  const t = useTranslations("dashboard");
  return (
    <footer className="border-t border-border py-6 text-sm text-text-muted">
      <div className="mx-auto flex max-w-[720px] flex-col gap-1 px-4 xl:max-w-[1200px]">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span>{t("footer")}</span>
          <Link
            href="/audit"
            aria-current={current ? "page" : undefined}
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-2 aria-[current=page]:font-bold aria-[current=page]:text-text aria-[current=page]:no-underline"
          >
            {t("footerAudit")}
          </Link>
          <SignOutButton />
        </p>
        <TimeZoneControl />
      </div>
    </footer>
  );
}
