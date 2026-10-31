// Payment row (components.md, M1 subset): status rail, MoneyCell + StatusBadge (PENDING shows PayPal's
// `status_details.reason`), the time in the workspace time zone, and the source tag. The payment detail
// page arrives with M2-05, so the row is not a link yet.
import type { PaymentItem } from "@cleared/core";
import { Loader2, Webhook } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import { captureStatusKey, formatTime, type StatusKey } from "../lib/format.ts";
import { MoneyCell } from "./MoneyCell.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

const RAIL: Record<StatusKey, string> = {
  completed: "bg-status-completed-fg",
  held: "bg-status-held-fg",
  refunded: "bg-status-neutral-fg",
  failed: "bg-status-error-fg",
  info: "bg-status-info-fg",
  resolved: "bg-status-neutral-fg",
};

const rowBase = "relative flex min-h-[72px] gap-3 border-b border-border bg-surface py-3 pr-4 pl-5";

export function PaymentRow({ p, timeZone, flash }: { p: PaymentItem; timeZone: string; flash: boolean }) {
  const t = useTranslations("row");
  const raw = useLocale();
  const key = captureStatusKey(p.status);
  // PayPal's exact enum beside the badge (copy rule 6): PENDING shows `status_details.reason`.
  const detail = key === "held" ? (p.statusReason ?? p.status) : p.status;
  return (
    <li className={`${rowBase} ${flash ? "flash" : ""}`} data-testid="payment-row" data-status={p.status}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${RAIL[key]}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 md:grid md:grid-cols-2 md:items-start md:gap-4">
        <div className="flex flex-col gap-1">
          <MoneyCell amount={p.amount} receivable={p.receivable} />
          <span className="font-mono text-xs break-all text-text-muted">{p.captureId}</span>
        </div>
        <div className="flex flex-col gap-1 md:items-end md:text-right">
          <StatusBadge status={key} detail={detail} />
          <span className="text-sm text-text-muted">
            <time dateTime={p.updatedAt}>
              {formatTime(intlLocale(isAppLocale(raw) ? raw : "en"), p.updatedAt, timeZone)}
            </time>
          </span>
          <span
            className="inline-flex items-center gap-1 text-xs text-status-info-fg"
            data-testid="source-tag"
          >
            <Webhook aria-hidden="true" size={14} strokeWidth={1.75} />
            {p.source === "webhook" ? t("viaWebhook") : t("viaPoll")}
          </span>
        </div>
      </div>
    </li>
  );
}

/** The row shown after "Create a sandbox test payment" until PayPal's webhook lands. */
export function WaitingRow() {
  const t = useTranslations("row");
  return (
    <li className={rowBase} data-testid="waiting-row">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-border-strong" />
      <span className="inline-flex items-center gap-2">
        <Loader2 aria-hidden="true" size={16} strokeWidth={1.75} className="spin" />
        <span>
          <span className="font-medium">{t("waiting")}</span>{" "}
          <span className="text-text-muted">{t("waitingHint")}</span>
        </span>
      </span>
    </li>
  );
}
