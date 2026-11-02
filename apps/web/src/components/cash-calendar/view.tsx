"use client";
// M3-05 calendar screen body (cash-calendar.md "Layout" + "States"): the view switch (List | Month; the
// default is List below 768 px and Month from 768 px; `?view=` keeps the choice), then `CashCalendar` fed
// by GET /api/cash-calendar. Month view shows the selected day's events beside the grid (1440) or below it.
// States: loading, error (Retry + Reference), empty ("No held money"; deadlines still show), success. The
// table (server-rendered by the page) is passed in as `children`; in List view it sits in "Show as table".
import {
  addDays,
  CashCalendarResponseSchema,
  localDay,
  type CashCalendarResponse,
  type CashEvent,
  type CashRange,
} from "@cleared/core";
import { CalendarDays, List } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { useRouter } from "../../i18n/navigation.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { useUiLocale } from "../disputes/text.ts";
import { EmptyState } from "../EmptyState.tsx";
import { OfflineBanner, useLoadedAt } from "../holds/Offline.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { CashCalendar } from "./index.tsx";
import { DayGroup } from "./list.tsx";
import { eventHref, type CashView } from "./types.ts";

const fetchCalendar = async (path: string): Promise<CashCalendarResponse> =>
  CashCalendarResponseSchema.parse(await getJson(path));

/** `?view=` wins; otherwise List below 768 px, Month from 768 px (decided after mount). */
function useView(initial: CashView | null): [CashView | null, (v: CashView) => void] {
  const [view, setView] = useState<CashView | null>(initial);
  useEffect(() => {
    if (initial === null) setView(window.matchMedia("(min-width: 768px)").matches ? "month" : "list");
  }, [initial]);
  const choose = (v: CashView) => {
    setView(v);
    const url = new URL(window.location.href);
    url.searchParams.set("view", v);
    window.history.replaceState(null, "", url);
  };
  return [view, choose];
}

function ViewSwitch({ view, onChange }: { view: CashView | null; onChange: (v: CashView) => void }) {
  const t = useTranslations("calendar");
  const options = [
    { v: "list" as const, icon: List },
    { v: "month" as const, icon: CalendarDays },
  ];
  return (
    <div
      role="group"
      aria-label={t("viewLabel")}
      className="inline-flex self-start rounded-md border border-border-strong bg-surface p-0.5"
      data-testid="view-switch"
    >
      {options.map(({ v, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => {
            onChange(v);
          }}
          className="inline-flex min-h-11 min-w-24 items-center justify-center gap-2 rounded-sm px-4 font-medium text-accent aria-pressed:bg-accent aria-pressed:text-on-accent"
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
          {t(`view.${v}`)}
        </button>
      ))}
    </div>
  );
}

function Loading() {
  const t = useTranslations("calendar");
  return (
    <div aria-busy="true" className="flex flex-col gap-3" data-testid="loading">
      {[0, 1, 2].map((i) => (
        <span key={i} aria-hidden="true" className="skeleton-pulse block h-14 rounded-lg" />
      ))}
      <p role="status" className="text-text-muted">
        {t("loading")}
      </p>
    </div>
  );
}

function SelectedDay({
  data,
  date,
  locale,
  onSelect,
}: {
  data: CashCalendarResponse;
  date: string | null;
  locale: string;
  onSelect: (e: CashEvent) => void;
}) {
  const t = useTranslations("calendar");
  if (date === null)
    return (
      <p className="text-text-muted" data-testid="day-panel">
        {t("selectDay")}
      </p>
    );
  const events = data.events.filter((e) => e.date === date);
  return (
    <div aria-live="polite" data-testid="day-panel">
      {events.length === 0 ? (
        <p className="text-text-muted">{t("dayNothing")}</p>
      ) : (
        <DayGroup
          date={date}
          events={events}
          totals={data.totals.filter((x) => x.date === date)}
          locale={locale}
          onSelect={onSelect}
          headingLevel={2}
        />
      )}
    </div>
  );
}

export function CashCalendarView({
  range,
  initialView,
  table,
}: {
  range: CashRange;
  initialView: CashView | null;
  /** the server-rendered "Upcoming releases and deadlines" table */
  table: ReactNode;
}) {
  const t = useTranslations("calendar");
  const locale = useUiLocale();
  const router = useRouter();
  const [view, setView] = useView(initialView);
  const [loaded, setLoaded] = useState<CashRange>(range);
  const [day, setDay] = useState<string | null>(null);
  const key = `/api/cash-calendar?from=${loaded.from}&to=${loaded.to}`;
  const { data, error, isValidating, mutate } = useSWR<CashCalendarResponse, unknown>(key, fetchCalendar, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  const loadedAt = useLoadedAt(data);

  const onSelect = (e: CashEvent) => {
    router.push(eventHref(e));
  };
  const onRangeChange = (from: string, to: string) => {
    if (from >= loaded.from && to <= loaded.to) return;
    setLoaded({ from, to: addDays(from, 91) });
  };

  let body: ReactNode;
  if (data === undefined && error === undefined) body = <Loading />;
  else if (data === undefined)
    body = (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  else if (data.events.length === 0 && data.heldNow.length === 0)
    body = <EmptyState icon={CalendarDays} title={t("emptyTitle")} body={t("empty")} />;
  else if (view === null) body = <Loading />;
  else {
    const today = localDay(new Date().toISOString(), data.timezone);
    const calendar = (
      <CashCalendar
        events={data.events}
        totals={data.totals}
        locale={locale}
        tz={data.timezone}
        view={view}
        initialDate={today}
        rangeEnd={data.range.to}
        onSelect={onSelect}
        onRangeChange={onRangeChange}
        onDaySelect={setDay}
        selectedDay={day}
      />
    );
    body =
      view === "list" ? (
        calendar
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1100px)_340px]">
          <div className="min-w-0">{calendar}</div>
          <SelectedDay data={data} date={day} locale={locale} onSelect={onSelect} />
        </div>
      );
  }

  return (
    <div className="flex flex-col gap-6">
      {data === undefined ? null : <OfflineBanner loadedAt={loadedAt} timeZone={data.timezone} />}
      <ViewSwitch view={view} onChange={setView} />
      <div data-testid="calendar-area" data-view={view ?? ""}>
        {body}
      </div>
      {view === "list" && data !== undefined ? (
        <details className="rounded-lg" data-testid="table-disclosure">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-accent underline underline-offset-2">
            {t("table.show")}
          </summary>
          <div className="mt-3">{table}</div>
        </details>
      ) : (
        table
      )}
    </div>
  );
}
