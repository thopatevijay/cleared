// Dashboard, M1 subset (dashboard.md elements 1, 2, 3a, 17 + the payments list and its states). The
// proxy redirects requests without a session cookie; this page also checks the session in the database.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { FirstView } from "../../../src/components/FirstView.tsx";
import { PaymentsView } from "../../../src/components/PaymentsView.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { pageTitle } from "../../../src/lib/site.ts";
import { firstView } from "../../../src/server/first-view.ts";
import { getDisputes } from "../../../src/server/handlers/disputes.ts";
import { getPayments } from "../../../src/server/handlers/payments.ts";
import { getScenarios } from "../../../src/server/handlers/scenarios.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("dashboard");
  return { title: pageTitle(t("title")) };
}

export default async function Payments({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await pageSession();
  if (session === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("dashboard");
  // M4-08: the first view comes with the HTML (the payments list, the dispute summary and the scenario
  // entry above the list, so nothing shifts when they arrive)
  const fallback = await firstView([
    ["/api/payments", getPayments],
    ["/api/disputes", getDisputes],
    ["/api/scenarios", getScenarios],
  ]);
  return (
    <>
      <SiteHeader skipTo="payments" skipLabel="skipPayments" signedIn />
      <main id="main" className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 xl:max-w-[1200px]">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {/* M4-07: demo data retention (ADR 0020) */}
        {session.kind === "demo" ? (
          <p
            className="rounded-lg border border-border bg-surface px-4 py-3 text-sm"
            data-testid="demo-retention-note"
          >
            {t("demoRetention")}
          </p>
        ) : null}
        <FirstView fallback={fallback}>
          <PaymentsView />
        </FirstView>
      </main>
      <DashboardFooter />
    </>
  );
}
