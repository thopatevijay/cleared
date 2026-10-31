// The pack state banner (payment-detail.md §2): one line, icon + text, in a polite live region so a state
// change is announced once. collecting (info) · checking (spinner) · checked (completed, with counts) ·
// stale (held) · AI unavailable (info) · budget reached (info). M2-09 reuses it on the dispute screen.
import type { PackViewState, Verdict } from "@cleared/core";
import { CircleCheck, Info, Loader2, RefreshCw, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { formatTime } from "../../lib/format.ts";

type Shown = Exclude<PackViewState, "empty">;

const STYLE: Readonly<Record<Shown, { icon: LucideIcon; tone: string; key: string; spin?: boolean }>> = {
  collecting: { icon: Info, tone: "bg-status-info-bg text-status-info-fg", key: "collecting" },
  checking: { icon: Loader2, tone: "bg-status-info-bg text-status-info-fg", key: "checking", spin: true },
  checked: { icon: CircleCheck, tone: "bg-status-completed-bg text-status-completed-fg", key: "checked" },
  stale: { icon: RefreshCw, tone: "bg-status-held-bg text-status-held-fg", key: "stale" },
  check_unavailable: { icon: Info, tone: "bg-status-info-bg text-status-info-fg", key: "aiDown" },
  budget_exceeded: { icon: Info, tone: "bg-status-info-bg text-status-info-fg", key: "budget" },
};

export function PackStateBanner({
  view,
  checkedAt,
  counts,
  timeZone,
}: {
  view: PackViewState;
  checkedAt: string | null;
  counts: Readonly<Record<Verdict, number>>;
  timeZone: string;
}) {
  const t = useTranslations("pack.banner");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  if (view === "empty") return <div aria-live="polite" data-testid="pack-banner" data-state={view} />;
  const s = STYLE[view];
  const Icon = s.icon;
  const time = checkedAt === null ? "" : formatTime(locale, checkedAt, timeZone);
  return (
    <div aria-live="polite" data-testid="pack-banner" data-state={view}>
      <p className={`flex items-start gap-2 rounded-md px-4 py-3 ${s.tone}`}>
        <Icon
          aria-hidden="true"
          size={s.spin === true ? 16 : 20}
          strokeWidth={1.75}
          className={`mt-1 shrink-0 ${s.spin === true ? "spin" : ""}`}
        />
        <span>{t(s.key, { time, met: counts.met, partial: counts.partial, missing: counts.missing })}</span>
      </p>
    </div>
  );
}
