// Status badge (components.md): icon + label + colour, never colour alone. PayPal's exact enum sits
// beside the pill (mono, muted), never inside it.
import { CircleCheck, CircleX, Hourglass, Info, Undo2, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { StatusKey } from "../lib/format.ts";

const STYLE: Record<StatusKey, { icon: LucideIcon; pill: string }> = {
  completed: { icon: CircleCheck, pill: "bg-status-completed-bg text-status-completed-fg" },
  held: { icon: Hourglass, pill: "bg-status-held-bg text-status-held-fg" },
  refunded: { icon: Undo2, pill: "bg-status-neutral-bg text-status-neutral-fg" },
  failed: { icon: CircleX, pill: "bg-status-error-bg text-status-error-fg" },
  info: { icon: Info, pill: "bg-status-info-bg text-status-info-fg" },
};

export function StatusBadge({ status, detail }: { status: StatusKey; detail?: string | null }) {
  const t = useTranslations("status");
  const { icon: Icon, pill } = STYLE[status];
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`inline-flex h-6 items-center gap-1 rounded-pill px-2 text-sm font-medium ${pill}`}>
        <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
        {t(status)}
      </span>
      {detail ? (
        <span className="font-mono text-xs break-all text-text-muted">
          <span className="sr-only">, </span>
          {detail}
        </span>
      ) : null}
    </span>
  );
}
