// M3-05 cash calendar words (cash-calendar.md "Copy" and rule 2): the visible label of each event kind,
// its accessible name ("64.00 US dollars, estimated release, estimated, Thursday 5 November, source …"),
// the day heading and the day's totals per currency. Amounts in PayPal's currency (core formatMoney, M4-03).
import { formatMoney, type Amount, type CashDayTotal, type CashEvent } from "@cleared/core";
import { useTranslations } from "next-intl";
import { formatAmount } from "../../lib/format.ts";
import { dayInstant } from "./types.ts";

const money = (locale: string, a: Amount): string => {
  const f = formatAmount(locale, a);
  return `${f.text} ${f.code}`;
};

/** "$420" for whole amounts, "€15.50" otherwise: the 375 px day cell (the full amount is in the day list). */
function shortAmount(locale: string, a: Amount): string {
  return formatMoney(a.value, a.currency, locale, "narrowSymbol", true);
}

function formatDayName(locale: string, date: string, long: boolean): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short",
    timeZone: "UTC",
    numberingSystem: "latn",
  }).format(new Date(dayInstant(date)));
}

export function useCashText(locale: string) {
  const t = useTranslations("calendar");
  const label = (e: CashEvent): string => {
    const amount = money(locale, e.amount);
    switch (e.kind) {
      case "estimated_release":
        return t("kind.estimated", { amount });
      case "dispute_deadline":
        return t("kind.deadline", { amount });
      case "released":
        return t("kind.released", { amount });
      case "service_completed_due":
        return `${amount} · ${t("kind.completedDue")}`;
    }
  };
  const name = (e: CashEvent): string =>
    [
      formatAmount(locale, e.amount).spoken,
      t(`kindName.${e.kind}`),
      ...(e.estimated ? [t("estimated")] : []),
      formatDayName(locale, e.date, true),
      ...(e.source === null ? [] : [t("sourceName", { source: e.source.title })]),
    ].join(", ");
  const dayTotals = (totals: readonly CashDayTotal[]): string[] =>
    totals.flatMap((x) => [
      ...(x.estimated === "0"
        ? []
        : [t("dayEstimated", { amount: money(locale, { value: x.estimated, currency: x.currency }) })]),
      ...(x.released === "0"
        ? []
        : [t("dayReleased", { amount: money(locale, { value: x.released, currency: x.currency }) })]),
    ]);
  return {
    label,
    name,
    /** the visible label first (the accessible name contains the visible text), then the full name */
    fullName: (e: CashEvent): string => `${label(e)}. ${name(e)}`,
    dayTotals,
    money: (a: Amount) => money(locale, a),
    /** "$64.00" (symbol only: the compact 375 px day cell) */
    short: (a: Amount) => shortAmount(locale, a),
    day: (date: string) => formatDayName(locale, date, false),
    dayLong: (date: string) => formatDayName(locale, date, true),
  };
}
