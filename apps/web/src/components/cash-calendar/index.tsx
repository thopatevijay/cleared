"use client";
// M3-05 `CashCalendar` (ADR 0016): one engine-neutral component. List view is our own list; Month view is
// `BryntumCashCalendar`, client-only (`next/dynamic`, `ssr: false`; ~1.5 MiB gzip, loaded only when Month
// is shown). While the engine loads, and if its chunk fails, the table below the calendar has every date.
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { CashList } from "./list.tsx";
import type { CashCalendarProps } from "./types.ts";

export type { CashCalendarProps, CashView } from "./types.ts";

function EngineLoading() {
  const t = useTranslations("calendar");
  return (
    <div aria-busy="true" className="flex flex-col gap-3" data-testid="engine-loading">
      <span aria-hidden="true" className="skeleton-pulse block h-[420px] rounded-lg" />
      <p role="status" className="text-text-muted">
        {t("engineLoading")}
      </p>
    </div>
  );
}

function EngineFailed() {
  const t = useTranslations("calendar");
  return (
    <p role="status" className="rounded-lg border border-border bg-surface p-4" data-testid="engine-failed">
      {t("engineFailed")}
    </p>
  );
}

const BryntumCashCalendar = dynamic<CashCalendarProps>(
  () => import("./bryntum.tsx").catch(() => ({ default: EngineFailed })),
  { ssr: false, loading: EngineLoading },
);

export function CashCalendar(p: CashCalendarProps & { rangeEnd: string }) {
  if (p.view === "list") return <CashList {...p} />;
  return <BryntumCashCalendar {...p} />;
}
