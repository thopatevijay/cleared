"use client";
// M3-05 `CashCalendar` (ADR 0016): one engine-neutral component. List view is our own list; Month view is
// `BryntumCashCalendar`, client-only (`next/dynamic`, `ssr: false`; ~1.5 MiB gzip, loaded only when Month
// is shown). While the engine loads, and if its chunk fails, the table below the calendar has every date.
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { loadEngine } from "./engine.ts";
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
    <p
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border bg-status-info-bg p-4 text-status-info-fg"
      data-testid="engine-failed"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <Info aria-hidden="true" size={18} strokeWidth={1.75} />
      </span>
      {t("engineFailed")}
    </p>
  );
}

// The engine file first (from our origin, not bundled: BL-01 6595246110), then the wrapper that uses it.
const BryntumCashCalendar = dynamic<CashCalendarProps>(
  () =>
    loadEngine()
      .then(() => import("./bryntum.tsx"))
      .catch(() => ({ default: EngineFailed })),
  { ssr: false, loading: EngineLoading },
);

export function CashCalendar(p: CashCalendarProps & { rangeEnd: string }) {
  if (p.view === "list") return <CashList {...p} />;
  return <BryntumCashCalendar {...p} />;
}
