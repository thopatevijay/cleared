// Summary bar (components.md): the held total per currency (from mirrored PENDING captures, M1-07), the
// "in dispute" total per currency (M2-09; "—" when disputes fail to load) and the proof-ready count
// (M2-05). One fact per line at 375 px.
import type { Amount } from "@cleared/core";
import { FileCheck, Hourglass, Scale, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link } from "../i18n/navigation.ts";
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
 * dashboard.md 3b (M2-09): "{amount} in dispute" per currency, a link that filters the list
 * (`?filter=dispute`). `null` = disputes failed to load ("—"; the list shows the inline band);
 * `undefined` = still loading.
 */
function DisputeFact({
  inDispute,
  active,
}: {
  inDispute: readonly Amount[] | null | undefined;
  active: boolean;
}) {
  const t = useTranslations("dashboard");
  const td = useTranslations("disputes.dashboard");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  if (inDispute === undefined || inDispute === null) return <Fact icon={Scale}>{t("inDisputeNone")}</Fact>;
  if (inDispute.length === 0) return <Fact icon={Scale}>{td("noneInDispute")}</Fact>;
  const text = inDispute.map((a) => `${formatAmount(locale, a).text} ${a.currency}`).join(" + ");
  return (
    <Link
      href={{ pathname: "/payments", query: { filter: "dispute" } }}
      aria-current={active ? "true" : undefined}
      className="inline-flex min-h-11 items-start gap-2 underline decoration-border-strong underline-offset-4 hover:decoration-accent"
      data-testid="summary-dispute"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <Scale aria-hidden="true" size={22} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span>{td("inDispute", { amount: text })}</span>
    </Link>
  );
}

/** dashboard.md 3c (M2-05): the proof-ready count, a link that filters the list (`?filter=proof-ready`). */
function ProofReadyFact({ count, active }: { count: number; active: boolean }) {
  const t = useTranslations("dashboard.summary");
  return (
    <Link
      href={{ pathname: "/payments", query: { filter: "proof-ready" } }}
      aria-label={t("proofReadyName", { count })}
      aria-current={active ? "true" : undefined}
      className="inline-flex min-h-11 items-start gap-2 underline decoration-border-strong underline-offset-4 hover:decoration-accent"
      data-testid="summary-proof-ready"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <FileCheck aria-hidden="true" size={22} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span>{t("proofReady", { count })}</span>
    </Link>
  );
}

export function SummaryBar({
  held,
  proofReady,
  filter,
  inDispute,
}: {
  held: readonly Amount[];
  proofReady: number;
  filter: string | null;
  /** M2-09: open disputes per currency; null when they failed to load */
  inDispute?: readonly Amount[] | null | undefined;
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
      <DisputeFact inDispute={inDispute} active={filter === "dispute"} />
      <ProofReadyFact count={proofReady} active={filter === "proof-ready"} />
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
