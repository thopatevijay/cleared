// Summary bar (components.md, M1): the held total per currency (from mirrored PENDING captures), the
// "in dispute" total per currency (M2-09; "—" when disputes fail to load), and the proof-ready fact ("—"
// until M2-05 delivers it). One fact per line at 375 px.
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

/**
 * M2-09 (dashboard.md 3b): "{amount} in dispute" per currency, a button that filters the list to dispute
 * rows. `null` = disputes failed to load ("—"; the list shows the inline band); `undefined` = loading.
 */
function DisputeFact({
  inDispute,
  onFilter,
}: {
  inDispute: readonly Amount[] | null | undefined;
  onFilter: () => void;
}) {
  const t = useTranslations("dashboard");
  const td = useTranslations("disputes.dashboard");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  if (inDispute === undefined || inDispute === null) return <Fact icon={Scale}>{t("inDisputeNone")}</Fact>;
  if (inDispute.length === 0) return <Fact icon={Scale}>{td("noneInDispute")}</Fact>;
  const text = inDispute.map((a) => `${formatAmount(locale, a).text} ${a.currency}`).join(" + ");
  return (
    <button
      type="button"
      onClick={onFilter}
      aria-label={`${td("inDispute", { amount: text })}. ${td("inDisputeFilter")}`}
      className="min-h-11 rounded-md text-left underline decoration-border-strong underline-offset-4 hover:decoration-accent md:inline-flex"
      data-testid="summary-dispute"
    >
      <Fact icon={Scale}>{td("inDispute", { amount: text })}</Fact>
    </button>
  );
}

export function SummaryBar({
  held,
  inDispute,
  onFilterDispute = () => undefined,
}: {
  held: readonly Amount[];
  inDispute?: readonly Amount[] | null | undefined;
  onFilterDispute?: () => void;
}) {
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
      <DisputeFact inDispute={inDispute} onFilter={onFilterDispute} />
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
