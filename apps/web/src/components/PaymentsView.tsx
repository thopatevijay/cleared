"use client";
// The dashboard's live part (M1-07): SWR polls GET /api/payments every 5 s while the tab is visible.
// States: loading (skeletons; a line after 3 s and 10 s), empty (+ the sandbox test-payment button),
// waiting ("Waiting for PayPal…" until the webhook lands), success, error (with the correlation id).
// New rows flash and are announced once in one polite live region.
import { PaymentsResponseSchema, type PaymentItem, type PaymentsResponse } from "@cleared/core";
import { FileCheck, Inbox } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Link, useRouter } from "../i18n/navigation.ts";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import { ApiError, getJson } from "../lib/api.ts";
import { attentionRank, captureStatusKey, formatAmount } from "../lib/format.ts";
import { EmptyState } from "./EmptyState.tsx";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { SamplesLink } from "./holds/SampleScenarios.tsx";
import { PaymentRow, WaitingRow } from "./PaymentRow.tsx";
import { DisputesBand } from "./payments/DisputeLines.tsx";
import { DisputeFilterChip, useDisputes } from "./payments/useDashboardDisputes.tsx";
import { ScenarioEntry } from "./scenario/ScenarioEntry.tsx";
import { SummaryBar, SummarySkeleton } from "./SummaryBar.tsx";
import { TestPaymentButton } from "./TestPaymentButton.tsx";

export const POLL_MS = 5_000;

async function fetchPayments(path: string): Promise<PaymentsResponse> {
  return PaymentsResponseSchema.parse(await getJson(path));
}

function useElapsed(active: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const started = Date.now();
    const id = setInterval(() => {
      setS(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return s;
}

/** Ids that arrived since the previous poll (none on the first load), plus the announcement for them. */
function useArrivals(items: readonly PaymentItem[] | undefined): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (items === undefined) return;
    const ids = new Set(items.map((i) => i.id));
    if (seen.current !== null) {
      const prev = seen.current;
      const added = items.filter((i) => !prev.has(i.id)).map((i) => i.id);
      if (added.length > 0) setFresh(new Set(added));
    }
    seen.current = ids;
  }, [items]);
  return fresh;
}

function Loading() {
  const t = useTranslations("dashboard");
  const s = useElapsed(true);
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-6">
      <SummarySkeleton />
      <ul aria-hidden="true" className="overflow-hidden rounded-lg border border-border">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="flex h-[88px] flex-col justify-center gap-2 border-b border-border bg-surface px-5 last:border-b-0"
          >
            <span className="skeleton-pulse block h-6 w-24 rounded-md" />
            <span className="skeleton-pulse block h-4 w-40 rounded-md" />
          </li>
        ))}
      </ul>
      <p className="text-text-muted" role="status">
        {s >= 10 ? t("loadingSlower") : s >= 3 ? t("loadingSlow") : ""}
      </p>
    </div>
  );
}

/** The active summary filter (dashboard.md: `?filter=proof-ready`) and the link that clears it. */
function FilterChip({ empty }: { empty: boolean }) {
  const t = useTranslations("dashboard.filter");
  return (
    <div className="flex flex-col gap-2" data-testid="filter-chip">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-pill bg-status-info-bg px-3 py-1 text-sm text-status-info-fg">
          <FileCheck aria-hidden="true" size={16} strokeWidth={1.75} />
          {t("proofReady")}
        </span>
        <Link
          href="/payments"
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
        >
          {t("clear")}
        </Link>
      </p>
      {empty ? <p className="text-text-muted">{t("none")}</p> : null}
    </div>
  );
}

export function PaymentsView() {
  const t = useTranslations();
  const filter = useSearchParams().get("filter");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const router = useRouter();
  const { data, error, isValidating, mutate } = useSWR<PaymentsResponse, unknown>(
    "/api/payments",
    fetchPayments,
    {
      refreshInterval: POLL_MS,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
      keepPreviousData: true,
    },
  );
  const fresh = useArrivals(data?.items);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);

  useEffect(() => {
    if (data === undefined || fresh.size === 0) return;
    const p = data.items.find((i) => fresh.has(i.id));
    if (p === undefined) return;
    const a = formatAmount(locale, p.amount);
    setAnnouncement(
      t("row.arrived", { amount: `${a.text} ${a.code}`, status: t(`status.${captureStatusKey(p.status)}`) }),
    );
  }, [fresh, data, locale, t]);

  const disputes = useDisputes();

  let body;
  if (data === undefined && error === undefined) {
    body = <Loading />;
  } else if (data === undefined) {
    body = (
      <ErrorPanel
        title={t("dashboard.errorTitle")}
        body={t("dashboard.errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => {
          void mutate();
        }}
      />
    );
  } else {
    const byPayment = disputes.byPayment;
    const proofOnly = filter === "proof-ready";
    const disputeOnly = filter === "dispute";
    const items = [...data.items]
      .filter((p) => !proofOnly || p.pack?.proofReady === true)
      .filter((p) => !disputeOnly || byPayment.has(p.id))
      .sort(
        (a, b) =>
          (byPayment.has(a.id) ? -1 : attentionRank(a.status)) -
          (byPayment.has(b.id) ? -1 : attentionRank(b.status)),
      );
    const waiting = proofOnly || disputeOnly ? 0 : data.testPayments.waiting;
    const capped = data.testPayments.usedToday >= data.testPayments.limit;
    body = (
      <div className="flex flex-col gap-6">
        <SummaryBar
          held={data.summary.held}
          proofReady={data.summary.proofReady}
          filter={filter}
          inDispute={disputes.error ? null : disputes.data?.summary.inDispute}
        />
        {disputes.error ? <DisputesBand reference={disputes.reference} onRetry={disputes.retry} /> : null}
        {/* M2-10: "Run the dispute scenario" (sandbox; demo and owner workspaces) */}
        <ScenarioEntry />
        {error !== undefined ? (
          <ErrorPanel
            title={t("dashboard.errorTitle")}
            body={t("dashboard.errorBody")}
            reference={error instanceof ApiError ? error.correlationId : null}
            onRetry={() => {
              void mutate();
            }}
          />
        ) : null}
        <section
          aria-labelledby="payments-heading"
          id="payments"
          className="flex flex-col gap-3"
          tabIndex={-1}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="payments-heading" className="text-xl font-semibold">
              {t("dashboard.listHeading")}
            </h2>
            {items.length > 0 ? (
              <span className="text-sm text-text-muted">{t("dashboard.order")}</span>
            ) : null}
          </div>
          {proofOnly ? <FilterChip empty={items.length === 0} /> : null}
          {disputeOnly ? <DisputeFilterChip empty={items.length === 0} /> : null}
          {(proofOnly || disputeOnly) && items.length === 0 ? null : items.length === 0 && waiting === 0 ? (
            <EmptyState icon={Inbox} title={t("empty.title")} body={t("empty.body")} headingLevel={3}>
              <TestPaymentButton capped={capped} onQueued={() => void mutate()} />
            </EmptyState>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-border" data-testid="payments-list">
              {Array.from({ length: waiting }, (_, i) => (
                <WaitingRow key={`w${String(i)}`} />
              ))}
              {items.map((p) => (
                <PaymentRow
                  key={p.id}
                  p={p}
                  timeZone={data.workspace.timezone}
                  flash={fresh.has(p.id)}
                  dispute={byPayment.get(p.id) ?? null}
                />
              ))}
            </ul>
          )}
          {/* dashboard.md element 13 (M3-01): explainers, never payment rows */}
          {proofOnly || disputeOnly ? null : <SamplesLink />}
        </section>
      </div>
    );
  }
  return (
    <>
      {body}
      <p aria-live="polite" className="sr-only" data-testid="live-region">
        {announcement}
      </p>
    </>
  );
}
