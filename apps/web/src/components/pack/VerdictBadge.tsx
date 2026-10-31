// A verdict as icon + word, never colour alone (payment-detail.md §3): met `circle-check` (completed),
// partial `circle-dashed` (held), missing `circle-x` (error), unverifiable `circle-help` (neutral).
import type { Verdict } from "@cleared/core";
import { CircleCheck, CircleDashed, CircleHelp, CircleX, Clock, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export const VERDICT_STYLE: Readonly<Record<Verdict, { icon: LucideIcon; pill: string; fg: string }>> = {
  met: {
    icon: CircleCheck,
    pill: "bg-status-completed-bg text-status-completed-fg",
    fg: "text-status-completed-fg",
  },
  partial: { icon: CircleDashed, pill: "bg-status-held-bg text-status-held-fg", fg: "text-status-held-fg" },
  missing: { icon: CircleX, pill: "bg-status-error-bg text-status-error-fg", fg: "text-status-error-fg" },
  unverifiable: {
    icon: CircleHelp,
    pill: "bg-status-neutral-bg text-status-neutral-fg",
    fg: "text-status-neutral-fg",
  },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const t = useTranslations("pack.verdict");
  const { icon: Icon, pill } = VERDICT_STYLE[verdict];
  return (
    <span
      className={`inline-flex min-h-6 items-center gap-1 rounded-pill px-2 text-sm font-medium ${pill}`}
      data-verdict={verdict}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
      {t(verdict)}
    </span>
  );
}

/**
 * The dashboard's inline form (dashboard.md element 6): icon + the verdict word (`row.verdict.*`, passed
 * in as the rich-text chunk) in running text.
 */
export function VerdictWord({ verdict, children }: { verdict: Verdict | "pending"; children: ReactNode }) {
  const style = verdict === "pending" ? null : VERDICT_STYLE[verdict];
  const Icon = style?.icon ?? Clock;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-verdict={verdict}>
      <Icon aria-hidden="true" size={14} strokeWidth={1.75} className={style?.fg ?? "text-text-muted"} />
      {children}
    </span>
  );
}
