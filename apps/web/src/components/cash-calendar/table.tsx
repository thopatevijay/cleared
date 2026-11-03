// M3-05 text alternative (cash-calendar.md item 4): "Upcoming releases and deadlines", a real <table> of
// every event in the range, rendered on the server (works without JS, serves screen readers) for every
// engine. Date | Event | Amount | Estimate source; each event links to its hold or dispute. Also the
// "No estimate yet" list (holds whose rule gives no timeline). No hooks beyond next-intl: server-safe.
import type { CashCalendarResponse, CashEvent } from "@cleared/core";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import { RuleSource } from "../holds/RuleSource.tsx";
import { KIND_STYLE } from "./kinds.ts";
import { useReasonText } from "../holds/text.ts";
import { useCashText } from "./text.ts";
import { eventHref } from "./types.ts";

function Row({ e, locale }: { e: CashEvent; locale: string }) {
  const t = useTranslations("calendar");
  const text = useCashText(locale);
  const { icon: Icon } = KIND_STYLE[e.kind];
  return (
    <tr
      className="border-b border-border align-top last:border-b-0"
      data-testid="cash-table-row"
      data-kind={e.kind}
    >
      <td className="px-2 py-2 sm:px-3">
        <time dateTime={e.date}>{text.day(e.date)}</time>
      </td>
      <td className="px-2 py-2 sm:px-3">
        <Link
          href={eventHref(e)}
          aria-label={text.fullName(e)}
          className="inline-flex min-h-11 items-center gap-2 text-accent underline underline-offset-2"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" />
          <span className="break-words">{text.label(e)}</span>
        </Link>
      </td>
      <td className="tabular px-2 py-2 text-right sm:px-3">{text.money(e.amount)}</td>
      <td className="px-2 py-2 sm:px-3">
        {e.source === null ? (
          <span className="text-text-muted">{t("fromPayPal")}</span>
        ) : (
          <RuleSource source={e.source} />
        )}
      </td>
    </tr>
  );
}

export function CashTable({ data, locale }: { data: CashCalendarResponse; locale: string }) {
  const t = useTranslations("calendar");
  return (
    <div
      className="overflow-x-auto rounded-lg border border-border bg-surface"
      data-testid="cash-table"
      role="region"
      aria-label={t("table.caption")}
      tabIndex={0}
    >
      <table className="w-full border-collapse text-left">
        <caption className="px-2 py-2 sm:px-3 text-left text-lg font-semibold">{t("table.caption")}</caption>
        <thead className="border-b border-border bg-surface-sunken text-sm">
          <tr>
            <th scope="col" className="px-2 py-2 sm:px-3 font-semibold">
              {t("table.date")}
            </th>
            <th scope="col" className="px-2 py-2 sm:px-3 font-semibold">
              {t("table.event")}
            </th>
            <th scope="col" className="px-2 py-2 sm:px-3 text-right font-semibold">
              {t("table.amount")}
            </th>
            <th scope="col" className="px-2 py-2 sm:px-3 font-semibold">
              {t("table.source")}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.events.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-3 text-text-muted">
                {t("table.none")}
              </td>
            </tr>
          ) : (
            data.events.map((e) => <Row key={e.id} e={e} locale={locale} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Holds PayPal gives no timeline for: listed apart, never placed on a day (cash-calendar.md "Partial"). */
export function NoEstimate({ data, locale }: { data: CashCalendarResponse; locale: string }) {
  const t = useTranslations("calendar");
  const text = useCashText(locale);
  const reason = useReasonText();
  if (data.noEstimate.length === 0) return null;
  return (
    <section aria-labelledby="no-estimate" className="flex flex-col gap-2" data-testid="no-estimate">
      <h2 id="no-estimate" className="text-xl font-semibold">
        {t("noEstimateHeading")}
      </h2>
      <ul className="overflow-hidden rounded-lg border border-border bg-surface">
        {data.noEstimate.map((n) => (
          <li key={n.holdId} className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
            <Link
              href={`/holds/${n.holdId}`}
              aria-label={t("openHold", { amount: text.money(n.amount) })}
              className="tabular inline-flex min-h-11 items-center self-start text-lg font-semibold text-accent underline underline-offset-2"
            >
              {text.money(n.amount)}
            </Link>
            <span className="text-sm">{reason(n.reason)}</span>
            <span className="text-sm">
              {t("noEstimate")}
              {"."} <span className="inline-block font-mono text-xs text-text-muted">{n.reason}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
