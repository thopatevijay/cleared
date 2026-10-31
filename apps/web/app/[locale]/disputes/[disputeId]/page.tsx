// Dispute review (M2-09, dispute-review.md "Detail"): facts, the draft reply and its approval, filing status,
// outcome, the judge scenario (M2-10) and the audit trail. `disputeId` is our dispute id or PayPal's (deep
// links from alerts, M3-08). The dispute itself is read client-side (polled); this page checks the session.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { DisputeDetailView } from "../../../../src/components/disputes/DisputeDetailView.tsx";
import { SiteHeader } from "../../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../../src/components/SiteFooter.tsx";
import { Link } from "../../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../../src/lib/site.ts";
import { pageSession } from "../../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("disputes");
  return { title: pageTitle(t("title")) };
}

export default async function Dispute({
  params,
}: {
  params: Promise<{ locale: string; disputeId: string }>;
}) {
  const { locale, disputeId } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("disputes");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex max-w-[720px] flex-col gap-4 px-4 py-6 xl:max-w-[1200px]"
      >
        <Link
          href="/disputes"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {t("backToList")}
        </Link>
        <DisputeDetailView id={disputeId} />
      </main>
      <DashboardFooter />
    </>
  );
}
