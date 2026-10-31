"use client";
// The dashboard's dispute data (M2-09): GET /api/disputes on its own SWR (5 s), so a dispute failure is a
// partial state ("Couldn't load disputes. Payments are up to date.") and never blanks the payments. Also the
// chip for the `?filter=dispute` list filter that the "in dispute" summary fact applies.
import { Scale } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import useSWR from "swr";
import { Link } from "../../i18n/navigation.ts";
import { ApiError } from "../../lib/api.ts";
import type { DisputeList, DisputeSummary } from "../../lib/dispute-view.ts";
import { DISPUTES_POLL_MS, fetchDisputes } from "../disputes/DisputeList.tsx";

export function useDisputes() {
  const { data, error, mutate } = useSWR<DisputeList, unknown>("/api/disputes", fetchDisputes, {
    refreshInterval: DISPUTES_POLL_MS,
    refreshWhenHidden: false,
    keepPreviousData: true,
  });
  const byPayment = useMemo(() => {
    const m = new Map<string, DisputeSummary>();
    for (const d of data?.items ?? []) {
      if (d.payment === null) continue;
      const prev = m.get(d.payment.id);
      // one row per payment: an open dispute wins over a resolved one
      if (prev === undefined || (prev.status === "RESOLVED" && d.status !== "RESOLVED"))
        m.set(d.payment.id, d);
    }
    return m;
  }, [data]);
  return {
    data,
    byPayment,
    error: error !== undefined,
    reference: error instanceof ApiError ? error.correlationId : null,
    retry: () => void mutate(),
  };
}

/** The active `?filter=dispute` (dashboard.md "Interactions") and the link that clears it. */
export function DisputeFilterChip({ empty }: { empty: boolean }) {
  const t = useTranslations("disputes.dashboard");
  return (
    <div className="flex flex-col gap-2" data-testid="dispute-filter-chip">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-pill bg-status-dispute-bg px-3 py-1 text-sm text-status-dispute-fg">
          <Scale aria-hidden="true" size={16} strokeWidth={1.75} />
          {t("filterChip")}
        </span>
        <Link
          href="/payments"
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
        >
          {t("clearFilter")}
        </Link>
      </p>
      {empty ? <p className="text-text-muted">{t("filteredEmpty")}</p> : null}
    </div>
  );
}
