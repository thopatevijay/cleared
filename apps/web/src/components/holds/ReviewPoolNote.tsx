"use client";
// M3-10: a demo workspace that got no judge-pool review hold (none available or all over 20 h old) says why,
// with the sandbox badge: a real payment-review hold needs a buyer to approve a PayPal payment in a browser.
import { FlaskConical } from "lucide-react";
import { useTranslations } from "next-intl";

export function ReviewPoolNote() {
  const t = useTranslations("holds.reviewPool");
  return (
    <p
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3"
      data-testid="review-pool-note"
    >
      <span className="inline-flex min-h-6 items-center gap-1 rounded-pill bg-status-sandbox-bg px-2 py-0.5 text-xs font-medium text-status-sandbox-fg">
        <FlaskConical aria-hidden="true" size={14} strokeWidth={1.75} />
        {t("badge")}
      </span>
      <span>{t("body")}</span>
    </p>
  );
}
