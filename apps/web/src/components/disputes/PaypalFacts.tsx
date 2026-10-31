// PayPal facts (dispute-review.md §1): amount, status badge + PayPal's exact status and stage, the reason
// in words + its enum, the dispute ID (mono, copyable), the linked payment and its hold as PayPal reports it,
// the reply due date in the workspace time zone, and what PayPal's current HATEOAS links allow.
"use client";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import type { DisputeDetail } from "../../lib/dispute-view.ts";
import { formatTime } from "../../lib/format.ts";
import { MoneyCell } from "../MoneyCell.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { useDisputeText, useUiLocale } from "./text.ts";

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
        });
      }}
      className="min-h-11 min-w-11 rounded-md border border-border px-3 text-sm text-accent md:min-h-8"
    >
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

export function PaypalFacts({ d, timeZone }: { d: DisputeDetail["dispute"]; timeZone: string }) {
  const t = useTranslations("disputes.facts");
  const td = useTranslations("disputes");
  const text = useDisputeText();
  const locale = useUiLocale();
  const amount = d.amount ?? d.payment?.amount ?? null;
  const pay = d.payment;
  return (
    <section
      aria-labelledby="facts-heading"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="facts-heading" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <dl className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="paypal-facts">
        <Pair label={t("amount")}>{amount === null ? "—" : <MoneyCell amount={amount} />}</Pair>
        <Pair label={t("status")}>
          <StatusBadge status={d.status === "RESOLVED" ? "resolved" : "dispute"} detail={d.status} />
          {d.stage === null ? null : (
            <span className="mt-1 block text-sm text-text-muted">
              {t("stage")}: <code className="font-mono text-xs">{d.stage}</code>
            </span>
          )}
        </Pair>
        <Pair label={t("reason")}>
          {text.reason(d.reason)}
          {d.reason === null ? null : (
            <code className="block font-mono text-xs break-all text-text-muted">{d.reason}</code>
          )}
        </Pair>
        <Pair label={t("id")}>
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm break-all" data-testid="dispute-id">
              {d.disputeId}
            </code>
            <CopyButton value={d.disputeId} label={t("copyId")} />
          </span>
        </Pair>
        <Pair label={t("payment")}>
          {pay === null ? (
            <span className="text-text-muted">{t("noPayment")}</span>
          ) : (
            <span className="flex flex-col gap-1">
              <code className="font-mono text-xs break-all">{pay.captureId}</code>
              <span>
                {pay.status === "PENDING"
                  ? t("held", {
                      status: pay.statusReason === null ? pay.status : `${pay.status} / ${pay.statusReason}`,
                    })
                  : t("notHeld", { status: pay.status })}
              </span>
            </span>
          )}
        </Pair>
        <Pair label={t("due")}>
          {d.dueDate === null ? (
            td("dueNone")
          ) : (
            <span className="tabular">{formatTime(locale, d.dueDate, timeZone)}</span>
          )}
        </Pair>
        <div className="md:col-span-2">
          <Pair label={t("allowed")}>
            <span data-testid="allowed-actions">
              {d.allowedActions.length === 0 ? t("allowedNone") : d.allowedActions.map(text.link).join(", ")}
            </span>
          </Pair>
        </div>
      </dl>
    </section>
  );
}
