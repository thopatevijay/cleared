// Cash calendar (M3-05, cash-calendar.md). The session is checked in the database; the held-now total,
// the "Upcoming releases and deadlines" table and "No estimate yet" are rendered here on the server (they
// work without JS); the calendar itself loads client-side (`CashCalendarView`, Bryntum only in Month).
// `?from&to` (YYYY-MM-DD, ≤ 92 days) picks the range; the default is this month + 92 days; `?view=list|month`.
import { CashRangeSchema, type WorkspaceId } from "@cleared/core";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { CashCalendarView } from "../../../src/components/cash-calendar/view.tsx";
import { CashTable, NoEstimate } from "../../../src/components/cash-calendar/table.tsx";
import { SiteHeader } from "../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../src/components/SiteFooter.tsx";
import { Link } from "../../../src/i18n/navigation.ts";
import { intlLocale, isAppLocale } from "../../../src/i18n/routing.ts";
import { formatAmount } from "../../../src/lib/format.ts";
import { pageTitle } from "../../../src/lib/site.ts";
import { cashCalendar } from "../../../src/server/cash/calendar.ts";
import { getDeps } from "../../../src/server/deps.ts";
import { pageSession } from "../../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("calendar");
  return { title: pageTitle(t("title")) };
}

type Search = Record<string, string | string[] | undefined>;

export default async function Calendar({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Search>;
}) {
  const { locale } = await params;
  const session = await pageSession();
  if (session === null) redirect(`/${locale}?ended=1`);
  const sp = await searchParams;
  const asked = CashRangeSchema.safeParse({ from: sp["from"], to: sp["to"] });
  const view = sp["view"] === "list" || sp["view"] === "month" ? sp["view"] : null;
  const data = await cashCalendar(
    getDeps(),
    session.workspaceId as WorkspaceId,
    asked.success ? asked.data : null,
  );
  const t = await getTranslations("calendar");
  const th = await getTranslations("holds");
  const ui = intlLocale(isAppLocale(locale) ? locale : "en");
  const held = data.heldNow
    .map((a) => {
      const f = formatAmount(ui, a);
      return `${f.text} ${f.code}`;
    })
    .join(" · ");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" signedIn />
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-4 py-6">
        <Link
          href="/holds"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {th("backToInbox")}
        </Link>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="tabular text-xl font-semibold" data-testid="held-now">
            {data.heldNow.length === 0 ? t("heldNone") : t("heldNow", { amount: held })}
          </p>
          <p className="max-w-prose text-text-muted">{t("intro")}</p>
        </div>
        <CashCalendarView
          range={data.range}
          initialView={view}
          table={<CashTable data={data} locale={ui} />}
        />
        <NoEstimate data={data} locale={ui} />
      </main>
      <DashboardFooter />
    </>
  );
}
