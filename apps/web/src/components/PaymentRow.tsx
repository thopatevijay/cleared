// Payment row (components.md, M1 subset): status rail, MoneyCell + StatusBadge (PENDING shows PayPal's
// `status_details.reason`), the time in the workspace time zone, and the source tag. M2-05: the amount
// links to the payment's proof pack, the pack sub-line (element 6) and, for an empty pack, "Add proof"
// (element 16).
import type { PaymentItem, PaymentPack } from "@cleared/core";
import { Loader2, Webhook } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "../i18n/navigation.ts";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import type { DisputeSummary } from "../lib/dispute-view.ts";
import { captureStatusKey, formatAmount, formatTime, type StatusKey } from "../lib/format.ts";
import { VerdictWord } from "./pack/VerdictBadge.tsx";
import { MoneyCell } from "./MoneyCell.tsx";
import { DisputeLines } from "./payments/DisputeLines.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

const RAIL: Record<StatusKey, string> = {
  completed: "bg-status-completed-fg",
  held: "bg-status-held-fg",
  refunded: "bg-status-neutral-fg",
  failed: "bg-status-error-fg",
  info: "bg-status-info-fg",
  resolved: "bg-status-neutral-fg",
  dispute: "bg-status-dispute-fg",
};

const rowBase = "relative flex min-h-[72px] gap-3 border-b border-border bg-surface py-3 pr-4 pl-5";

/** dashboard.md element 6: the latest check in one line, each verdict as word + icon (never a bare tick). */
function PackLine({ pack }: { pack: PaymentPack }) {
  const t = useTranslations("row");
  const s = pack.summary;
  if (s === null) return null;
  return (
    <p className="text-sm break-words text-text-muted" data-testid="pack-line">
      {t.rich("pack", {
        scope: (chunks) => <VerdictWord verdict={s.scope}>{chunks}</VerdictWord>,
        delivery: (chunks) => <VerdictWord verdict={s.delivery}>{chunks}</VerdictWord>,
        // client sign-off arrives with M3-06; until then it shows as pending
        signoff: (chunks) => <VerdictWord verdict="pending">{chunks}</VerdictWord>,
        s: t(`verdict.${s.scope}`),
        d: t(`verdict.${s.delivery}`),
        c: t("verdict.pending"),
        n: s.sources,
      })}
    </p>
  );
}

/** dashboard.md element 16: a new payment whose pack is empty asks for proof, with one row action. */
function AddProof({ p, amount }: { p: PaymentItem; amount: string }) {
  const t = useTranslations("row");
  return (
    <div className="flex flex-col items-start gap-2" data-testid="new-payment">
      <p className="text-sm">{t("newPayment", { buyer: t("buyerUnknown") })}</p>
      <Link
        href={{ pathname: `/payments/${p.id}/pack`, query: { intake: "1" } }}
        aria-label={t("addProofName", { amount })}
        className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 font-medium"
        data-testid="add-proof"
      >
        {t("addProof")}
      </Link>
    </div>
  );
}

export function PaymentRow({
  p,
  timeZone,
  flash,
  dispute = null,
}: {
  p: PaymentItem;
  timeZone: string;
  flash: boolean;
  /** M2-09: the payment's dispute (dashboard.md elements 4, 5) */
  dispute?: DisputeSummary | null;
}) {
  const t = useTranslations("row");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const key = captureStatusKey(p.status);
  // PayPal's exact enum beside the badge (copy rule 6): PENDING shows `status_details.reason`.
  const detail = key === "held" ? (p.statusReason ?? p.status) : p.status;
  const f = formatAmount(locale, p.amount);
  const amount = `${f.text} ${f.code}`;
  return (
    <li
      className={`${rowBase} ${flash ? "flash" : ""}`}
      data-testid="payment-row"
      data-status={p.status}
      data-dispute={dispute === null ? undefined : dispute.disputeId}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${RAIL[dispute !== null && dispute.status !== "RESOLVED" ? "dispute" : key]}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 md:grid md:grid-cols-2 md:items-start md:gap-4">
        <div className="flex flex-col gap-1">
          {p.pack === null ? (
            <MoneyCell amount={p.amount} receivable={p.receivable} />
          ) : (
            <Link
              href={`/payments/${p.id}/pack`}
              aria-label={t("open", { amount })}
              className="self-start rounded-sm hover:underline"
              data-testid="payment-link"
            >
              <MoneyCell amount={p.amount} receivable={p.receivable} />
            </Link>
          )}
          <span className="font-mono text-xs break-all text-text-muted">{p.captureId}</span>
          {p.pack !== null && !p.pack.hasEvidence ? <AddProof p={p} amount={amount} /> : null}
          {p.pack !== null ? <PackLine pack={p.pack} /> : null}
        </div>
        <div className="flex flex-col gap-1 md:items-end md:text-right">
          <StatusBadge status={key} detail={detail} />
          <span className="text-sm text-text-muted">
            <time dateTime={p.updatedAt}>{formatTime(locale, p.updatedAt, timeZone)}</time>
          </span>
          <span
            className="inline-flex items-center gap-1 text-xs text-status-info-fg"
            data-testid="source-tag"
          >
            <Webhook aria-hidden="true" size={14} strokeWidth={1.75} />
            {p.source === "webhook" ? t("viaWebhook") : t("viaPoll")}
          </span>
        </div>
        {dispute === null ? null : (
          <div className="md:col-span-2">
            <DisputeLines d={dispute} timeZone={timeZone} />
          </div>
        )}
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
