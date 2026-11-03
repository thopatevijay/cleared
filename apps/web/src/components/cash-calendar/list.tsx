"use client";
// M3-05 list view (cash-calendar.md "375 px: list/agenda view"): our own list fed the same events as the
// engine. Day groups ("Thu 5 Nov") with the day's totals per currency, one 56 px+ row per event (icon,
// amount, kind label, "estimated", a Source disclosure); text wraps, never truncates. The next 30 days from
// `initialDate`, extended 30 days at a time. Also the selected-day panel of the month view (`DayEvents`).
import type { CashDayTotal, CashEvent } from "@cleared/core";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Link } from "../../i18n/navigation.ts";
import { RuleSource } from "../holds/RuleSource.tsx";
import { KIND_STYLE } from "./kinds.ts";
import { useCashText } from "./text.ts";
import { eventHref, type CashCalendarProps } from "./types.ts";
import { addDays } from "@cleared/core";

export const LIST_STEP_DAYS = 30;

function EventRow({
  e,
  locale,
  onSelect,
}: {
  e: CashEvent;
  locale: string;
  onSelect: (e: CashEvent) => void;
}) {
  const t = useTranslations("calendar");
  const text = useCashText(locale);
  const { icon: Icon, pill } = KIND_STYLE[e.kind];
  return (
    <li
      className="flex min-h-14 flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0"
      data-testid="cash-row"
      data-kind={e.kind}
    >
      <Link
        href={eventHref(e)}
        aria-label={text.fullName(e)}
        data-testid="cash-row-link"
        onClick={(ev) => {
          ev.preventDefault();
          onSelect(e);
        }}
        className="flex min-h-11 items-center gap-3 rounded-sm hover:underline"
      >
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill ${pill}`}>
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
        </span>
        <span className="tabular min-w-0 flex-1 text-lg font-semibold break-words">{text.label(e)}</span>
        <ChevronRight aria-hidden="true" size={20} strokeWidth={1.75} className="shrink-0 text-accent" />
      </Link>
      {e.source === null ? (
        <span className="pl-11 text-sm text-text-muted">{t("fromPayPal")}</span>
      ) : (
        <span className="pl-11 text-sm">
          <RuleSource source={e.source} />
        </span>
      )}
    </li>
  );
}

/** One day's group: heading, totals per currency, rows. */
export function DayGroup({
  date,
  events,
  totals,
  locale,
  onSelect,
  headingLevel = 3,
}: {
  date: string;
  events: readonly CashEvent[];
  totals: readonly CashDayTotal[];
  locale: string;
  onSelect: (e: CashEvent) => void;
  headingLevel?: 2 | 3;
}) {
  const text = useCashText(locale);
  const H = headingLevel === 2 ? "h2" : "h3";
  const lines = text.dayTotals(totals);
  return (
    <section
      aria-labelledby={`day-${date}`}
      className="overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="cash-day"
      data-date={date}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border bg-surface-sunken px-4 py-2">
        <H id={`day-${date}`} className="font-semibold">
          <time dateTime={date}>{text.day(date)}</time>
        </H>
        {lines.length > 0 ? (
          <span className="tabular text-sm text-text-muted" data-testid="cash-day-total">
            {lines.join(" · ")}
          </span>
        ) : null}
      </div>
      <ul>
        {events.map((e) => (
          <EventRow key={e.id} e={e} locale={locale} onSelect={onSelect} />
        ))}
      </ul>
    </section>
  );
}

function groupByDay(events: readonly CashEvent[]): [string, CashEvent[]][] {
  const by = new Map<string, CashEvent[]>();
  for (const e of events) by.set(e.date, [...(by.get(e.date) ?? []), e]);
  return [...by.entries()];
}

export function CashList(p: CashCalendarProps & { rangeEnd: string }) {
  const t = useTranslations("calendar");
  const [days, setDays] = useState(LIST_STEP_DAYS);
  const end = addDays(p.initialDate, days - 1);
  const shown = p.events.filter((e) => e.date >= p.initialDate && e.date <= end);
  const groups = groupByDay(shown);
  return (
    <div className="flex max-w-[760px] flex-col gap-4" data-testid="cash-list">
      <p className="text-sm text-text-muted">{t("listWindow", { days })}</p>
      {groups.length === 0 ? <p data-testid="cash-list-empty">{t("listEmpty", { days })}</p> : null}
      {groups.map(([date, evs]) => (
        <DayGroup
          key={date}
          date={date}
          events={evs}
          totals={p.totals.filter((x) => x.date === date)}
          locale={p.locale}
          onSelect={p.onSelect}
        />
      ))}
      {end < p.rangeEnd ? (
        <button
          type="button"
          onClick={() => {
            setDays(days + LIST_STEP_DAYS);
          }}
          className="min-h-11 self-start rounded-md border border-border-strong bg-surface px-4 font-medium text-accent hover:bg-surface-sunken"
          data-testid="cash-list-more"
        >
          {t("showMore")}
        </button>
      ) : null}
    </div>
  );
}
