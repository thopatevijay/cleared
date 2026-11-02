// Dashboard, M1 subset (dashboard.md elements 1, 2, 3a, 17 + the payments list and its states). The
// proxy redirects requests without a session cookie; this page also checks the session in the database.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { PaymentsView } from "../../../src/components/PaymentsView.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { pageTitle } from "../../../src/lib/site.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("dashboard");
  return { title: pageTitle(t("title")) };
}

export default async function Payments({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("dashboard");
  return (
    <>
      <SiteHeader skipTo="payments" skipLabel="skipPayments" signedIn />
      <main id="main" className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6 xl:max-w-[1200px]">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <PaymentsView />
      </main>
      <DashboardFooter />
    </>
  );
}
