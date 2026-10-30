// Audit log placeholder (audit-log.md, M1-07): h1 + the empty state; no fake rows. The workspace-wide
// page has no owning ticket yet (BL-01 6527538305).
import { ScrollText } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { EmptyState } from "../../../src/components/EmptyState.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { Link } from "../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../src/lib/site.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("audit");
  return { title: pageTitle(t("title")) };
}

export default async function Audit({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("audit");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 xl:max-w-[1200px]"
      >
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <EmptyState icon={ScrollText} title={t("emptyTitle")} body={t("empty")}>
          <Link
            href="/payments"
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
          >
            {t("back")}
          </Link>
        </EmptyState>
      </main>
      <DashboardFooter />
    </>
  );
}
