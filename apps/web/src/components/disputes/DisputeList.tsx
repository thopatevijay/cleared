"use client";
// Dispute list (dispute-review.md "List"): PayPal's status and stage verbatim, the reason in words + the
// enum, the amount, the reply due date in the workspace time zone with a countdown and the deadline
// badge. Soonest due first (the API's order). SWR polls every 5 s while the tab is visible.
import { Scale } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "../../i18n/navigation.ts";
import { Link } from "../../i18n/navigation.ts";
import { ApiError, getParsed } from "../../lib/api.ts";
import type { DisputeList as List, DisputeSummary } from "../../lib/dispute-view.ts";
import { formatTime, formatUtc } from "../../lib/format.ts";
import { codeBreaks } from "../CodeText.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { MoneyCell } from "../MoneyCell.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { DeadlineBadge } from "./DeadlineBadge.tsx";
import { useDisputeText, useUiLocale } from "./text.ts";

export const DISPUTES_POLL_MS = 5_000;

export async function fetchDisputes(path: string): Promise<List> {
  return getParsed(path, (s) => s.DisputeListSchema);
}

/** The current time, refreshed every minute (countdowns; client-only so the server render never differs). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return now;
}

function Row({ d, timeZone, now }: { d: DisputeSummary; timeZone: string; now: number }) {
  const t = useTranslations("disputes");
  const text = useDisputeText();
  const locale = useUiLocale();
  const amount = d.amount ?? d.payment?.amount ?? null;
  return (
    <li className="relative border-b border-border bg-surface last:border-b-0" data-testid="dispute-row">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-status-dispute-fg" />
      <Link
        href={`/disputes/${d.id}`}
        className="flex min-h-[72px] flex-col gap-1 py-3 pr-4 pl-5 hover:bg-surface-sunken md:grid md:grid-cols-2 md:gap-4"
      >
        <span className="flex flex-col gap-1">
          {amount === null ? null : <MoneyCell amount={amount} receivable={null} />}
          <span>
            {text.reason(d.reason)}
            {d.reason === null ? null : (
              <span className="ml-2 font-mono text-xs [overflow-wrap:anywhere] text-text-muted">
                {codeBreaks(d.reason)}
              </span>
            )}
          </span>
          <span className="sr-only">{t("open", { id: d.disputeId })}</span>
        </span>
        <span className="flex flex-col gap-1 md:items-end md:text-right">
          <StatusBadge
            status={d.status === "RESOLVED" ? "resolved" : "dispute"}
            detail={d.stage === null ? d.status : `${d.status} · ${d.stage}`}
          />
          <span className="text-sm" title={d.dueDate === null ? undefined : formatUtc(d.dueDate, locale)}>
            {d.dueDate === null ? t("dueNone") : t("due", { date: formatTime(locale, d.dueDate, timeZone) })}
          </span>
          {d.status === "RESOLVED" ? null : (
            <DeadlineBadge state={d.deadlineState} dueDate={d.dueDate} now={now} />
          )}
        </span>
      </Link>
    </li>
  );
}

export function DisputeList() {
  const t = useTranslations("disputes");
  const router = useRouter();
  const now = useNow();
  const { data, error, isValidating, mutate } = useSWR<List, unknown>("/api/disputes", fetchDisputes, {
    refreshInterval: DISPUTES_POLL_MS,
    refreshWhenHidden: false,
    keepPreviousData: true,
  });
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  if (data === undefined && error === undefined) {
    return (
      <div aria-busy="true" data-testid="loading" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <span key={i} aria-hidden="true" className="skeleton-pulse block h-[72px] rounded-md" />
        ))}
        <p role="status" className="text-text-muted">
          {t("loading")}
        </p>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  }
  if (data.items.length === 0) {
    return <EmptyState icon={Scale} title={t("emptyTitle")} body={t("empty")} />;
  }
  return (
    <section aria-labelledby="disputes-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="disputes-heading" className="sr-only">
          {t("listHeading")}
        </h2>
        <span className="text-sm text-text-muted">{t("order")}</span>
      </div>
      <ul className="overflow-hidden rounded-lg border border-border" data-testid="disputes-list">
        {data.items.map((d) => (
          <Row key={d.id} d={d} timeZone={data.workspace.timezone} now={now} />
        ))}
      </ul>
    </section>
  );
}
