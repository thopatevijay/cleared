// Payment detail and proof pack (M2-05, payment-detail.md). The server resolves the payment to its pack in
// this workspace (another workspace's payment, or an unknown one, renders the not-found page with a 404);
// the client loads GET /api/packs/:packId (loading and error states), polls it while the agent works and
// adds evidence.
import type { WorkspaceId } from "@cleared/core";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { FirstView } from "../../../../../src/components/FirstView.tsx";
import { PackScreen } from "../../../../../src/components/pack/PackScreen.tsx";
import { SiteHeader } from "../../../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../../../src/components/SiteFooter.tsx";
import { Link } from "../../../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../../../src/lib/site.ts";
import { getDeps } from "../../../../../src/server/deps.ts";
import { firstView } from "../../../../../src/server/first-view.ts";
import { getPack, packIdForPayment } from "../../../../../src/server/handlers/packs.ts";
import { pageSession } from "../../../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("pack");
  return { title: pageTitle(t("metaTitle")) };
}

export default async function PackPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; paymentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, paymentId } = await params;
  const session = await pageSession();
  if (session === null) redirect(`/${locale}?ended=1`);
  const deps = getDeps();
  const ws = session.workspaceId as WorkspaceId;
  const packId = await packIdForPayment(deps, ws, paymentId);
  if (packId === null) notFound();
  const focusIntake = (await searchParams)["intake"] === "1";
  const t = await getTranslations("pack");
  // M4-08: the pack's first view comes with the HTML (GET /api/packs/:packId's own handler)
  const fallback = await firstView([[`/api/packs/${packId}`, (req, d) => getPack(req, d, packId)]]);
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
        <FirstView fallback={fallback}>
          <PackScreen packId={packId} focusIntake={focusIntake} />
        </FirstView>
      </main>
      <DashboardFooter />
    </>
  );
}
