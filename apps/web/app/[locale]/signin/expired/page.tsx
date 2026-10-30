// Expired or used sign-in link (landing.md "Expired / used link"): GET /api/auth/verify sends browsers
// here. The form to request a new link, and the demo as the alternative.
import { getTranslations } from "next-intl/server";
import { DemoButton } from "../../../../src/components/DemoButton.tsx";
import { SignInForm } from "../../../../src/components/SignInForm.tsx";
import { SiteHeader } from "../../../../src/components/SiteHeader.tsx";
import { LandingFooter } from "../../../../src/components/SiteFooter.tsx";

export const dynamic = "force-dynamic";

export default async function Expired() {
  const t = await getTranslations("expired");
  return (
    <>
      <SiteHeader skipTo="main" skipLabel="skipMain" />
      <main id="main" tabIndex={-1} className="mx-auto flex max-w-[640px] flex-col gap-6 px-4 py-8">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p>{t("body")}</p>
        <SignInForm />
        <section aria-labelledby="demo-heading" className="flex flex-col gap-3 border-t border-border pt-6">
          <h2 id="demo-heading" className="text-lg font-semibold">
            {t("orDemo")}
          </h2>
          <DemoButton />
        </section>
      </main>
      <LandingFooter />
    </>
  );
}
