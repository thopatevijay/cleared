// Hold detail (M3-01, hold.md "Detail"). "#why" (the dashboard's "Why?") focuses the explanation section.
// The hold is read client-side (polled); this page checks the session.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { FirstView } from "../../../../src/components/FirstView.tsx";
import { HoldDetailView } from "../../../../src/components/holds/HoldDetailView.tsx";
import { SiteHeader } from "../../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../../src/components/SiteFooter.tsx";
import { Link } from "../../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../../src/lib/site.ts";
import { firstView } from "../../../../src/server/first-view.ts";
import { getHold } from "../../../../src/server/handlers/holds.ts";
import { pageSession } from "../../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("holds");
  return { title: pageTitle(t("title")) };
}

export default async function Hold({ params }: { params: Promise<{ locale: string; holdId: string }> }) {
  const { locale, holdId } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("holds");
  // M4-08: the hold's first view comes with the HTML (GET /api/holds/:id's own handler)
  const fallback = await firstView([[`/api/holds/${holdId}`, (req, d) => getHold(req, d, holdId)]]);
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main id="main" tabIndex={-1} className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 py-6">
        <Link
          href="/holds"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {t("backToInbox")}
        </Link>
        <FirstView fallback={fallback}>
          <HoldDetailView id={holdId} />
        </FirstView>
      </main>
      <DashboardFooter />
    </>
  );
}
