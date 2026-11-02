// Notification centre page (M3-08, notifications.md): the bell's target below 768 px and "See all". The
// items are read client-side (polled); this page only checks the session.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { NotificationsPage } from "../../../src/components/notifications/NotificationsPage.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { Link } from "../../../src/i18n/navigation.ts";
import { pageTitle } from "../../../src/lib/site.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("notifications");
  return { title: pageTitle(t("title")) };
}

export default async function Notifications({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if ((await pageSession()) === null) redirect(`/${locale}?ended=1`);
  const t = await getTranslations("notifications");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" signedIn />
      <main id="main" tabIndex={-1} className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6">
        <Link
          href="/payments"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {t("back")}
        </Link>
        <h1 id="notifications-title" tabIndex={-1} className="text-2xl font-bold">
          {t("title")}
        </h1>
        <NotificationsPage />
      </main>
      <DashboardFooter />
    </>
  );
}
