// Dispute list (M2-09, dispute-review.md "List"). The proxy redirects requests without a session cookie;
// this page also checks the session in the database. The list itself is read client-side (polled).
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { DisputeList } from "../../../src/components/disputes/DisputeList.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { Link } from "../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../src/lib/site.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("disputes");
  return { title: pageTitle(t("title")) };
}

export default async function Disputes({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("disputes");
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
        <DisputeList />
      </main>
      <DashboardFooter />
    </>
  );
}
