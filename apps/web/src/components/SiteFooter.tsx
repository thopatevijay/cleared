// Footers: the landing's sandbox disclaimer, and the dashboard's "you hold the keys" + audit-log link.
import { useTranslations } from "next-intl";
import { Link } from "../i18n/navigation.ts";

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
      <p className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-3 px-4 xl:max-w-[1200px]">
        <span>{t("footer")}</span>
        <Link
          href="/audit"
          aria-current={current ? "page" : undefined}
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
        >
          {t("footerAudit")}
        </Link>
      </p>
    </footer>
  );
}
