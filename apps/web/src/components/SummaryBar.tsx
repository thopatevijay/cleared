// Summary bar (components.md): the held total per currency (M3-01: active derived holds; a link to the
// held-money inbox), the
// "in dispute" total per currency (M2-09; "—" when disputes fail to load) and the proof-ready count
// (M2-05). One fact per line at 375 px.
import type { Amount } from "@cleared/core";
import { FileCheck, Hourglass, Scale, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Link } from "../i18n/navigation.ts";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import { formatAmountList } from "../lib/format.ts";

/** One fact; `pending` is the visible "Arrives with …" line for parts later tickets deliver. */
function Fact({
  icon: Icon,
  children,
  pending,
  testId,
}: {
  icon: LucideIcon;
  children: ReactNode;
  pending?: string;
  testId?: string;
}) {
  return (
    <span className="flex items-start gap-2 md:inline-flex" data-testid={testId}>
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
  const text = formatAmountList(locale, inDispute);
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

/**
 * dashboard.md 3c (M2-05): the proof-pack count ("2 proof packs ready"), a link that filters the list
 * (`?filter=proof-ready`; the hyphenated term is the URL value only, so the copy never breaks at a hyphen).
 * Zero is plain text like "Nothing held" and "Nothing in dispute": a filter to an empty list is not a
 * useful link (BL-01 6604837005 item 8, sweep M5). An active filter keeps the link (its aria-current).
 */
function ProofReadyFact({ count, active }: { count: number; active: boolean }) {
  const t = useTranslations("dashboard.summary");
  if (count === 0 && !active)
    return (
      <Fact icon={FileCheck} testId="summary-proof-ready">
        {t("proofReadyZero")}
      </Fact>
    );
  return (
    <Link
      href={{ pathname: "/payments", query: { filter: "proof-ready" } }}
      aria-label={count === 0 ? undefined : t("proofReadyName", { count })}
      aria-current={active ? "true" : undefined}
      className="inline-flex min-h-11 items-start gap-2 underline decoration-border-strong underline-offset-4 hover:decoration-accent"
      data-testid="summary-proof-ready"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <FileCheck aria-hidden="true" size={22} strokeWidth={1.75} className="text-text-muted" />
      </span>
      <span>{count === 0 ? t("proofReadyZero") : t("proofReady", { count })}</span>
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
  const heldText = formatAmountList(locale, held);
  return (
    <p
      className="tabular flex flex-col gap-1 text-2xl font-bold md:flex-row md:flex-wrap md:gap-x-6 md:text-money"
      data-testid="summary"
    >
      {held.length === 0 ? (
        <Fact icon={Hourglass}>{t("nothingHeld")}</Fact>
      ) : (
        // M3-01: derived holds per currency; opens the held-money inbox
        <Link
          href="/holds"
          className="inline-flex min-h-11 items-start gap-2 underline decoration-border-strong underline-offset-4 hover:decoration-accent"
          data-testid="summary-held"
        >
          <span className="flex h-[1lh] shrink-0 items-center">
            <Hourglass aria-hidden="true" size={22} strokeWidth={1.75} className="text-text-muted" />
          </span>
          <span>{t("held", { amount: heldText })}</span>
        </Link>
      )}
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
