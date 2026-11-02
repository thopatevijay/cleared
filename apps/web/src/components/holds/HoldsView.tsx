"use client";
// Held-money inbox (hold.md "Inbox", M3-01): the total held per currency ("$64.00 USD held in 1
// payment"), the hold rows (held badge + reason + EstimatedDate + "Why?"), then the Sample scenarios
// section. SWR polls GET /api/holds every 5 s while the tab is visible; a hold that leaves the list (PayPal
// released it) is announced once. States: loading, empty (the samples still show), error.
import { HoldsResponseSchema, type HoldItem, type HoldsResponse } from "@cleared/core";
import { CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Link, useRouter } from "../../i18n/navigation.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { formatAmount, formatTime } from "../../lib/format.ts";
import { useUiLocale } from "../disputes/text.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { MoneyCell } from "../MoneyCell.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { HeldLines } from "./HeldLines.tsx";
import { SampleScenarios } from "./SampleScenarios.tsx";
import { OfflineBanner, useLoadedAt } from "./Offline.tsx";
import { useReasonText } from "./text.ts";

export const HOLDS_POLL_MS = 5_000;

const fetchHolds = async (path: string): Promise<HoldsResponse> =>
  HoldsResponseSchema.parse(await getJson(path));

function useSlow(): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => {
      setSlow(true);
    }, 3000);
    return () => {
      clearTimeout(id);
    };
  }, []);
  return slow;
}

function Loading() {
  const t = useTranslations("holds");
  const slow = useSlow();
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-4">
      <span aria-hidden="true" className="skeleton-pulse block h-9 w-72 rounded-md" />
      {[0, 1].map((i) => (
        <span key={i} aria-hidden="true" className="skeleton-pulse block h-[88px] rounded-lg" />
      ))}
      <p role="status" className="text-text-muted">
        {slow ? t("loading") : ""}
      </p>
    </div>
  );
}

function HoldRow({ h, timeZone }: { h: HoldItem; timeZone: string }) {
  const t = useTranslations("holds");
  const reason = useReasonText();
  const locale = useUiLocale();
  const f = formatAmount(locale, h.amount);
  const amount = `${f.text} ${f.code}`;
  return (
    <li
      className="relative flex flex-col gap-2 border-b border-border bg-surface py-3 pr-4 pl-5 last:border-b-0"
      data-testid="hold-row"
      data-hold={h.id}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-status-held-fg" />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link
          href={`/holds/${h.id}`}
          aria-label={t("open", { amount })}
          className="rounded-sm hover:underline"
        >
          <MoneyCell amount={h.amount} />
        </Link>
        <StatusBadge status="held" detail={h.reason} />
      </div>
      <p>{reason(h.reason)}</p>
      <p className="text-sm text-text-muted">
        <time dateTime={h.openedAt}>
          {t("detail.opened", { time: formatTime(locale, h.openedAt, timeZone) })}
        </time>
      </p>
      <HeldLines
        hold={h}
        disputeDueAt={h.dispute?.dueDate ?? null}
        amount={amount}
        timeZone={timeZone}
        action
      />
    </li>
  );
}

/** Announces a hold that left the list since the previous poll (PayPal released it). */
function useReleases(items: readonly HoldItem[] | undefined): string {
  const t = useTranslations("holds.live");
  const locale = useUiLocale();
  const prev = useRef<readonly HoldItem[] | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (items === undefined) return;
    const ids = new Set(items.map((i) => i.id));
    const gone = prev.current?.find((i) => !ids.has(i.id));
    if (gone !== undefined) {
      const f = formatAmount(locale, gone.amount);
      setMsg(t("released", { amount: `${f.text} ${f.code}` }));
    }
    prev.current = items;
  }, [items, locale, t]);
  return msg;
}

export function HoldsView() {
  const t = useTranslations("holds");
  const locale = useUiLocale();
  const router = useRouter();
  const { data, error, isValidating, mutate } = useSWR<HoldsResponse, unknown>("/api/holds", fetchHolds, {
    refreshInterval: HOLDS_POLL_MS,
    refreshWhenHidden: false,
    keepPreviousData: true,
  });
  const announcement = useReleases(data?.items);
  const loadedAt = useLoadedAt(data);
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);

  let body;
  if (data === undefined && error === undefined) body = <Loading />;
  else if (data === undefined)
    body = (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  else if (data.items.length === 0)
    body = <EmptyState icon={CircleCheck} title={t("emptyTitle")} body={t("empty")} />;
  else {
    const total = data.summary.held
      .map((a) => {
        const f = formatAmount(locale, a);
        return `${f.text} ${f.code}`;
      })
      .join(" + ");
    body = (
      <section aria-labelledby="holds-heading" className="flex flex-col gap-3">
        <p className="tabular text-2xl font-bold md:text-money" data-testid="holds-total">
          {t("total", { amount: total, count: data.summary.count })}
        </p>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="holds-heading" className="text-xl font-semibold">
            {t("listHeading")}
          </h2>
          <span className="text-sm text-text-muted">{t("order")}</span>
        </div>
        <ul className="overflow-hidden rounded-lg border border-border" data-testid="holds-list">
          {data.items.map((h) => (
            <HoldRow key={h.id} h={h} timeZone={data.workspace.timezone} />
          ))}
        </ul>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {data === undefined ? null : <OfflineBanner loadedAt={loadedAt} timeZone={data.workspace.timezone} />}
      {body}
      <SampleScenarios />
      <p aria-live="polite" className="sr-only" data-testid="live-region">
        {announcement}
      </p>
    </div>
  );
}
