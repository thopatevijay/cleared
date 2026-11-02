"use client";
// Sample scenarios (dashboard.md element 13, hold.md): holds the sandbox can't produce (new-seller
// 21-day hold, reserve, account limitation), explained from PayPal's published words. Each carries the
// badge "Sample scenario: sandbox can't produce this", shows no amount and has no action. They are never
// payment rows and never count towards the held total.
import { SAMPLE_RULES } from "@cleared/core";
import { ChevronRight, FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import { RuleSource } from "./RuleSource.tsx";

export function SampleBadge() {
  const t = useTranslations("holds.samples");
  return (
    <span className="inline-flex min-h-6 items-center gap-1 self-start rounded-pill bg-status-sandbox-bg px-2 py-0.5 text-xs font-medium text-status-sandbox-fg">
      <FlaskConical aria-hidden="true" size={14} strokeWidth={1.75} />
      {t("badge")}
    </span>
  );
}

/** The link at the end of the dashboard list. */
export function SamplesLink() {
  const t = useTranslations("holds");
  return (
    <Link
      href="/holds#samples"
      className="inline-flex min-h-11 flex-wrap items-center gap-2 self-start text-accent underline underline-offset-2"
      data-testid="samples-link"
    >
      <FlaskConical aria-hidden="true" size={16} strokeWidth={1.75} />
      {t("samplesLink")}
      <ChevronRight aria-hidden="true" size={16} strokeWidth={1.75} />
    </Link>
  );
}

export function SampleScenarios() {
  const t = useTranslations("holds.samples");
  return (
    <section
      id="samples"
      tabIndex={-1}
      aria-labelledby="samples-heading"
      className="flex scroll-mt-16 flex-col gap-3"
      data-testid="samples"
    >
      <h2 id="samples-heading" className="text-xl font-semibold">
        {t("title")}
      </h2>
      <p className="max-w-prose text-text-muted">{t("intro")}</p>
      <ul className="flex flex-col gap-3">
        {SAMPLE_RULES.map((r) => (
          <li
            key={r.id}
            id={`sample-${r.id}`}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
            data-testid="sample"
            data-sample={r.id}
          >
            <SampleBadge />
            <h3 className="text-lg font-semibold">{t(`${r.id}.title`)}</h3>
            <p className="max-w-prose">{t(`${r.id}.body`)}</p>
            <p className="text-sm text-text-muted">{t("whatPayPalSays")}</p>
            <blockquote className="border-l-2 border-border-strong pl-3 text-sm break-words">
              {r.sources[0].quote}
            </blockquote>
            <RuleSource source={r.sources[0]} />
          </li>
        ))}
      </ul>
    </section>
  );
}
