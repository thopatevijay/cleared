// Money cell (components.md): the amount in tabular figures + ISO code; a second line with the receivable
// amount when PayPal reported one in another currency. Never converts or sums currencies.
import type { Amount } from "@cleared/core";
import { useLocale, useTranslations } from "next-intl";
import { intlLocale, isAppLocale } from "../i18n/routing.ts";
import { formatAmount } from "../lib/format.ts";

export function MoneyCell({ amount, receivable }: { amount: Amount; receivable?: Amount | null }) {
  const t = useTranslations("row");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const a = formatAmount(locale, amount);
  const r = receivable && receivable.currency !== amount.currency ? formatAmount(locale, receivable) : null;
  return (
    <span className="inline-flex flex-col">
      <span className="tabular whitespace-nowrap">
        <span aria-hidden="true" className="text-lg font-semibold">
          {a.text}
        </span>{" "}
        <span aria-hidden="true" className="text-xs text-text-muted">
          {a.code}
        </span>
        <span className="sr-only">{a.spoken}</span>
      </span>
      {r ? (
        <span className="tabular text-sm text-text-muted">
          {t("receive", { amount: `${r.text} ${r.code}` })}
        </span>
      ) : null}
    </span>
  );
}
