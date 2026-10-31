"use client";
// The payment header (payment-detail.md §1): the amount and what the seller receives, PayPal's status
// (verbatim reason beside the badge), the capture and order IDs (mono, wrapped, copyable), when it was
// captured (workspace time zone) and how it reached Cleared.
import type { PackView } from "@cleared/core";
import { Copy, Webhook } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { captureStatusKey, formatAmount, formatTime } from "../../lib/format.ts";
import { MoneyCell } from "../MoneyCell.tsx";
import { StatusBadge } from "../StatusBadge.tsx";

function CopyId({ label, value }: { label: string; value: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-2">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="font-mono text-sm break-all">{value}</dd>
      <dd>
        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 text-sm text-accent"
          aria-label={copied ? t("common.copied") : t("pack.copyId", { label })}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
            });
          }}
        >
          <Copy aria-hidden="true" size={16} strokeWidth={1.75} />
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </dd>
    </div>
  );
}

export function PaymentHeader({ payment, timeZone }: { payment: PackView["payment"]; timeZone: string }) {
  const t = useTranslations();
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const key = captureStatusKey(payment.status);
  const a = formatAmount(locale, payment.amount);
  return (
    <header className="flex flex-col gap-3" data-testid="payment-header">
      <h1 className="text-2xl font-bold">{t("pack.title", { amount: `${a.text} ${a.code}` })}</h1>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <MoneyCell amount={payment.amount} receivable={payment.receivable} />
        <StatusBadge
          status={key}
          detail={key === "held" ? (payment.statusReason ?? payment.status) : payment.status}
        />
      </div>
      <dl className="flex flex-col gap-1">
        <CopyId label={t("pack.captureId")} value={payment.captureId} />
        {payment.orderId !== null ? <CopyId label={t("pack.orderId")} value={payment.orderId} /> : null}
      </dl>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
        <time dateTime={payment.capturedAt}>
          {t("pack.captured", { time: formatTime(locale, payment.capturedAt, timeZone) })}
        </time>
        <span className="inline-flex items-center gap-1 text-status-info-fg">
          <Webhook aria-hidden="true" size={14} strokeWidth={1.75} />
          {payment.source === "webhook" ? t("row.viaWebhook") : t("row.viaPoll")}
        </span>
      </p>
    </header>
  );
}
