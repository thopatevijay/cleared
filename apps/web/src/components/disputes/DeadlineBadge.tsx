// The reply deadline (dispute-review.md): `t72` held colours + clock, `t24` error colours + alarm clock,
// `closed_for_action` neutral + lock ("Too late to reply here"). The absolute date is always in text next
// to it; the countdown is supplementary.
import { DEADLINE_STATES, deadlineState, fromEpochMs, type DeadlineState } from "@cleared/core";
import { AlarmClock, Clock, Lock, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { countdown } from "../../lib/format.ts";

const STYLE: Record<"t72" | "t24" | "closed" | "ok", { icon: LucideIcon; pill: string }> = {
  t72: { icon: Clock, pill: "bg-status-held-bg text-status-held-fg" },
  t24: { icon: AlarmClock, pill: "bg-status-error-bg text-status-error-fg" },
  closed: { icon: Lock, pill: "bg-status-neutral-bg text-status-neutral-fg" },
  ok: { icon: Clock, pill: "bg-surface-sunken text-text-muted" },
};

/**
 * The state to show: the stored one (the deadline watcher's, which can lag behind the clock) or the one
 * the clock gives now, whichever is more urgent (BL-01 6604837005 item 2, sweep M5).
 */
export function shownDeadlineState(stored: DeadlineState, dueDate: string | null, now: number): DeadlineState {
  if (dueDate === null) return stored;
  const live = deadlineState(fromEpochMs(Date.parse(dueDate)), fromEpochMs(now));
  return DEADLINE_STATES.indexOf(live) > DEADLINE_STATES.indexOf(stored) ? live : stored;
}

export function DeadlineBadge({
  state: stored,
  dueDate,
  now,
}: {
  state: DeadlineState;
  dueDate: string | null;
  now: number;
}) {
  const t = useTranslations("disputes.deadline");
  const state = shownDeadlineState(stored, dueDate, now);
  if (dueDate === null && state !== "closed_for_action") return null;
  const key = state === "closed_for_action" ? "closed" : state;
  const c = dueDate === null ? { unit: "days" as const, n: 0 } : countdown(now, dueDate);
  const label =
    key === "closed"
      ? t("closed")
      : c.unit === "hours"
        ? t("t24", { n: c.n })
        : t(key === "t24" ? "t72" : key, { n: c.n });
  const { icon: Icon, pill } = STYLE[key];
  return (
    <span
      className={`inline-flex min-h-6 items-center self-start md:self-end gap-1 rounded-pill px-2 text-sm font-medium ${pill}`}
      data-testid="deadline-badge"
      data-state={state}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
      {label}
    </span>
  );
}
