// Summary bar (components.md, M1): the held total per currency (from mirrored PENDING captures); the
// dispute and proof-ready facts show "—" until M2-09 / M2-05 deliver them. One fact per line at 375 px.
import type { Amount } from "@cleared/core";
import { FileCheck, Hourglass, Scale, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import { formatAmount } from "../lib/format.ts";

/** One fact; `pending` is the visible "Arrives with …" line for parts later tickets deliver. */
function Fact({
  icon: Icon,
  children,
  pending,
}: {
  icon: LucideIcon;
  children: ReactNode;
  pending?: string;
}) {
  return (
    <span className="flex items-start gap-2 md:inline-flex">
      <span className="flex h-[1lh] shrink-0 items-center">
        <Icon aria-hidden="true" size={22} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span className="flex flex-col">
        <span>{children}</span>
        {pending ? <span className="text-sm font-normal text-text-muted">{pending}</span> : null}
      </span>
    </span>
  );
}

export function SummaryBar({ held }: { held: readonly Amount[] }) {
  const t = useTranslations("dashboard");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const heldText = held
    .map((a) => {
      const f = formatAmount(locale, a);
      return `${f.text} ${f.code}`;
    })
    .join(" + ");
  return (
    <p
      className="tabular flex flex-col gap-1 text-2xl font-bold md:flex-row md:flex-wrap md:gap-x-6 md:text-money"
      data-testid="summary"
    >
      <Fact icon={Hourglass}>{held.length === 0 ? t("nothingHeld") : t("held", { amount: heldText })}</Fact>
      <Fact icon={Scale} pending={t("pendingDispute")}>
        {t("inDisputeNone")}
      </Fact>
      <Fact icon={FileCheck} pending={t("pendingProof")}>
        {t("proofReadyNone")}
      </Fact>
    </p>
  );
}

export function SummarySkeleton() {
  return (
    <div
      className="flex flex-col gap-2 md:flex-row md:gap-6"
      aria-hidden="true"
      data-testid="summary-skeleton"
    >
      {[0, 1, 2].map((i) => (
        <span key={i} className="skeleton-pulse block h-8 w-56 rounded-md" />
      ))}
    </div>
  );
}
