// Not found / foreign payment (payment-detail.md "States"): one sentence and the way back, nothing about
// whether the payment exists in another workspace.
import { SearchX } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SiteHeader } from "../../../../src/components/SiteHeader.tsx";
import { DashboardFooter } from "../../../../src/components/SiteFooter.tsx";
import { Link } from "../../../../src/i18n/navigation.ts";

export default async function PaymentNotFound() {
  const t = await getTranslations("pack");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main id="main" tabIndex={-1} className="mx-auto flex max-w-[720px] flex-col gap-6 px-4 py-6">
        <section className="flex flex-col items-start gap-3" data-testid="not-found">
          <SearchX aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
          <h1 className="text-2xl font-bold">{t("notFound")}</h1>
          <Link
            href="/payments"
            className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
          >
            {t("back")}
          </Link>
        </section>
      </main>
      <DashboardFooter />
    </>
  );
}
