// The public client acknowledgement page (M3-06, client-ack.md). No session and no site navigation: the
// seller's client reads the agreed scope (plain text), types a name, ticks "I agree" and confirms. Every
// unusable token (unknown, expired, revoked, scope changed, already accepted) renders the same neutral
// page. The proxy sets the nonce CSP, `noindex`, `no-referrer` and `no-store` for this route.
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AckForm, NeutralPanel } from "../../../../src/components/ack/AckForm.tsx";
import { LanguageSwitch } from "../../../../src/components/LanguageSwitch.tsx";
import { MoneyCell } from "../../../../src/components/MoneyCell.tsx";
import { SandboxBadge } from "../../../../src/components/SandboxBadge.tsx";
import { pageTitle } from "../../../../src/lib/site.ts";
import { getDeps } from "../../../../src/server/deps.ts";
import { loadPublicAck } from "../../../../src/server/handlers/ack.ts";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ack");
  return {
    title: pageTitle(t("metaTitle")),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

async function Header() {
  const t = await getTranslations("common");
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-14 max-w-[640px] flex-wrap items-center justify-between gap-x-3 px-4">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xl leading-none font-bold" lang="en">
            {t("wordmark")}
          </span>
          <SandboxBadge />
        </span>
        <LanguageSwitch />
      </div>
    </header>
  );
}

export default async function AckPage({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("ack");
  const ack = await loadPublicAck(getDeps(), token);
  const seller = ack?.sellerName ?? t("sellerFallback");
  return (
    <>
      <Header />
      <main id="main" className="mx-auto flex max-w-[640px] flex-col gap-6 px-4 py-6">
        {ack === null ? (
          <NeutralPanel />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl font-semibold">{t("title")}</h1>
              <p>{t("from", { seller })}</p>
            </div>
            <p className="flex flex-col gap-1">
              <span className="text-sm text-text-muted">{t("amountLabel")}</span>
              <MoneyCell amount={{ value: ack.amount, currency: ack.currency }} />
            </p>
            <section aria-labelledby="ack-scope-heading" className="flex flex-col gap-2">
              <h2 id="ack-scope-heading" className="text-xl font-semibold">
                {t("scopeHeading")}
              </h2>
              <div
                role="region"
                aria-labelledby="ack-scope-heading"
                tabIndex={0}
                dir="auto"
                data-testid="ack-scope"
                className="max-h-[max(50vh,240px)] overflow-y-auto rounded-md border border-border bg-surface-sunken p-4 leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
              >
                {ack.scopeText}
              </div>
            </section>
            <noscript>
              <p>{t("noscript")}</p>
            </noscript>
            <AckForm token={token} seller={seller} />
          </>
        )}
      </main>
      <footer className="mx-auto max-w-[640px] px-4 pb-8 text-xs text-text-muted">{t("footer")}</footer>
    </>
  );
}
