"use client";
// The dashboard's dispute pieces (dashboard.md elements 3b, 4, 5; M2-09): the dispute lines inside a
// `PaymentRow` (the `dispute` badge + PayPal status, the reason in words + enum, the reply due date), the
// "Reply ready" line with the secondary "Review and approve" (no one-tap approve: it opens dispute review
// with focus on the ApprovalCard), and the inline band when disputes fail to load.
import { CircleX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import type { DisputeSummary } from "../../lib/dispute-view.ts";
import { formatDay } from "../../lib/format.ts";
import { useDisputeText, useUiLocale } from "../disputes/text.ts";
import { StatusBadge } from "../StatusBadge.tsx";

export function DisputeLines({ d, timeZone }: { d: DisputeSummary; timeZone: string }) {
  const t = useTranslations("disputes.dashboard");
  const td = useTranslations("disputes");
  const text = useDisputeText();
  const locale = useUiLocale();
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-2" data-testid="dispute-lines">
      <StatusBadge status={d.status === "RESOLVED" ? "resolved" : "dispute"} detail={d.status} />
      <span>
        <span data-testid="dispute-reason">{text.reason(d.reason)}</span>
        {d.dueDate === null ? null : (
          <span className="tabular text-text-muted" data-testid="dispute-due">
            {" · "}
            {t("due", { date: formatDay(locale, d.dueDate, timeZone) })}
          </span>
        )}
      </span>
      {d.reason === null ? null : (
        <code className="font-mono text-xs break-all text-text-muted">{d.reason}</code>
      )}
      {d.draftReady ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">{t("replyReady")}</span>
          <Link
            href={`/disputes/${d.id}#approval`}
            className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 font-medium text-accent hover:bg-surface-sunken"
            data-testid="review-approve"
          >
            {t("reviewApprove")}
          </Link>
        </span>
      ) : (
        <Link
          href={`/disputes/${d.id}`}
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {td("open", { id: d.disputeId })}
        </Link>
      )}
    </div>
  );
}

export function DisputesBand({ reference, onRetry }: { reference: string | null; onRetry: () => void }) {
  const t = useTranslations("disputes.dashboard");
  const tc = useTranslations("common");
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-status-error-bg p-3 text-status-error-fg"
      data-testid="disputes-band"
    >
      <CircleX aria-hidden="true" size={20} strokeWidth={1.75} />
      <span className="flex-1">{t("band")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 rounded-md border border-border-strong bg-surface px-4 font-medium text-accent"
      >
        {tc("retry")}
      </button>
      {reference === null ? null : (
        <span className="text-sm">
          {tc("reference")}
          {": "}
          <code className="font-mono text-xs break-all">{reference}</code>
        </span>
      )}
    </div>
  );
}
