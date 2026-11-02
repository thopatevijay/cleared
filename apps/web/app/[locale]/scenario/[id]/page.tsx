// The judge dispute scenario (M2-10; dispute-review.md §5): the timeline of real sandbox steps, the
// mirrored outcome and "Simulate PayPal's decision (sandbox only)". Its components are reused by M2-09's
// dispute detail. The run itself is read client-side (polled); this page only checks the session.
import { platform } from "@cleared/db";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ScenarioScreen } from "../../../../src/components/scenario/ScenarioView.tsx";
import { SiteHeader } from "../../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../../src/components/SiteFooter.tsx";
import { Link } from "../../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../../src/lib/site.ts";
import { getDeps } from "../../../../src/server/deps.ts";
import { pageSession } from "../../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("scenario");
  return { title: pageTitle(t("title")) };
}

export default async function Scenario({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const session = await pageSession();
  if (session === null) redirect(`/${locale}?ended=1`);
  const ws = await platform(getDeps().db).workspaces.get(session.workspaceId);
  const t = await getTranslations("scenario");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" signedIn />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 xl:max-w-[1200px]"
      >
        <Link
          href="/payments"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {t("back")}
        </Link>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="max-w-prose">{t("intro")}</p>
        <ScenarioScreen id={id} timeZone={ws?.timezone ?? "UTC"} />
      </main>
      <DashboardFooter />
    </>
  );
}
