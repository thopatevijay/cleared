// Landing (landing.md, M1-07): explain the product, "Try as demo seller", magic-link sign-in. A visitor
// with a valid session goes straight to the dashboard.
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DemoButton } from "../../src/components/DemoButton.tsx";
import { SignInForm } from "../../src/components/SignInForm.tsx";
import { SiteHeader } from "../../src/components/SiteHeader.tsx";
import { LandingFooter } from "../../src/components/SiteFooter.tsx";
import { README_URL } from "../../src/lib/site.ts";
import { pageSession } from "../../src/server/page-session.ts";

export const dynamic = "force-dynamic";

export default async function Landing({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ ended?: string }>;
}) {
  const { locale } = await params;
  if ((await pageSession()) !== null) redirect(`/${locale}/payments`);
  const ended = (await searchParams).ended === "1";
  const t = await getTranslations("landing");
  const en = (chunks: ReactNode) => <span lang="en">{chunks}</span>;
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto max-w-[640px] px-4 py-8 xl:grid xl:max-w-[1200px] xl:grid-cols-12 xl:gap-12"
      >
        <div className="flex flex-col gap-6 xl:col-span-7">
          {ended ? (
            <p role="status" className="rounded-md bg-status-info-bg p-3 text-status-info-fg">
              {t("sessionEnded")}
            </p>
          ) : null}
          <h1 className="text-2xl font-bold xl:text-money">{t("h1")}</h1>
          <p className="max-w-prose">{t("intro")}</p>
          <div className="order-2 md:order-3">
            <DemoButton />
          </div>
          <section className="order-3 md:order-2" aria-labelledby="steps-heading">
            <h2 id="steps-heading" className="mb-2 text-lg font-semibold">
              {t("stepsTitle")}
            </h2>
            <ol className="flex list-decimal flex-col gap-1 pl-6">
              <li>{t("step1")}</li>
              <li>{t("step2")}</li>
              <li>{t("step3")}</li>
              <li>{t.rich("step4", { en })}</li>
            </ol>
          </section>
        </div>
        <div className="mt-8 flex flex-col gap-6 xl:col-span-5 xl:mt-0">
          <section aria-labelledby="signin-heading" className="flex flex-col gap-3">
            <h2 id="signin-heading" className="text-lg font-semibold">
              {t("alreadySeller")}
            </h2>
            <SignInForm />
          </section>
          <section className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-4 text-sm">
            <p>{t("real")}</p>
            <a
              href={README_URL}
              className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
            >
              {t("readme")}
            </a>
          </section>
        </div>
      </main>
      <LandingFooter />
    </>
  );
}
