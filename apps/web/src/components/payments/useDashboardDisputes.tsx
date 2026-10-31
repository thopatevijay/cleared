"use client";
// The dashboard's dispute data (M2-09): GET /api/disputes on its own SWR (5 s), so a dispute failure is a
// partial state ("Couldn't load disputes. Payments are up to date.") and never blanks the payments. Also the
// `?filter=dispute` list filter that the "in dispute" summary fact applies (dashboard.md "Interactions").
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import useSWR from "swr";
import { usePathname, useRouter } from "../../i18n/navigation.ts";
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

export function useDisputeFilter() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  return {
    on: params.get("filter") === "dispute",
    set: () => {
      router.replace(`${pathname}?filter=dispute`, { scroll: false });
    },
    clear: () => {
      router.replace(pathname, { scroll: false });
    },
  };
}

export function FilterChip({ onClear }: { onClear: () => void }) {
  const t = useTranslations("disputes.dashboard");
  return (
    <p className="flex flex-wrap items-center gap-2" data-testid="filter-chip">
      <span className="rounded-pill bg-status-dispute-bg px-3 py-1 text-sm font-medium text-status-dispute-fg">
        {t("filterChip")}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-accent underline underline-offset-2"
      >
        <X aria-hidden="true" size={16} />
        {t("clearFilter")}
      </button>
    </p>
  );
}
