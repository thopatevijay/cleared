"use client";
// M3-05 `BryntumCashCalendar` (ADR 0016, cash-calendar.md rules 1-7): Bryntum Calendar 7.3.8 (trial, see
// config/cash-calendar.ts) in month mode only, read-only, every editing feature off. Client-only: loaded by
// `index.tsx` through next/dynamic { ssr: false }.
// - All-day days are passed as `YYYY-MM-DD` and `timeZone` is never set (M0-09: +1 day shift; rule 6).
// - Colours by kind from our tokens (`cash-ev--<kind>` classes, bryntum-theme.css), never Bryntum's.
// - Renderers return DomConfig with `text` (textContent), never an HTML string (innerHTML).
// - Enter / Space on a focused event select it (Bryntum's own Enter opens the editor); arrows stay Bryntum's.
// - Day cells show the day's totals per currency; selecting a day reports it (`onDaySelect`).
import type { CashEvent } from "@cleared/core";
import type { DomConfig, EventModel, MonthViewConfig } from "@bryntum/calendar";
import { BryntumCalendar } from "@bryntum/calendar-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import "@bryntum/calendar/calendar.css";
import "@bryntum/calendar/svalbard-light.css";
import "@bryntum/calendar/fontawesome/css/fontawesome.css";
import "@bryntum/calendar/fontawesome/css/solid.css";
import "./bryntum-theme.css";
import { CASH_CALENDAR_ENGINE } from "../../../config/cash-calendar.ts";
import { addDays } from "@cleared/core";
import { useCashText } from "./text.ts";
import type { CashCalendarProps } from "./types.ts";

/** A Bryntum (local, all-day) Date as `YYYY-MM-DD`. */
const ymd = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Hindi month and day names from Bryntum's own locale (`/hi`); English is built in. */
function useBryntumLocale(locale: string): boolean {
  const hindi = locale.startsWith("hi");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const live = { current: true };
    void (async () => {
      const { LocaleManager } = await import("@bryntum/calendar");
      if (hindi) await import("@bryntum/calendar/locales/calendar.locale.Hi.js");
      await LocaleManager.applyLocale(hindi ? "Hi" : "En");
      if (live.current) setReady(true);
    })();
    return () => {
      live.current = false;
    };
  }, [hindi]);
  return ready;
}

/** Below 640 px the month grid shows counts only (cash-calendar.md "375 px"). */
function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => {
      setCompact(mq.matches);
    };
    on();
    mq.addEventListener("change", on);
    return () => {
      mq.removeEventListener("change", on);
    };
  }, []);
  return compact;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);
  return reduced;
}

export default function BryntumCashCalendar(p: CashCalendarProps) {
  const t = useTranslations("calendar");
  const text = useCashText(p.locale);
  const ready = useBryntumLocale(p.locale);
  const reduced = useReducedMotion();
  const compact = useCompact();
  const byId = useMemo(() => new Map(p.events.map((e) => [e.id, e])), [p.events]);

  const events = useMemo(
    () =>
      p.events.map((e) => ({
        id: e.id,
        // the wrapper's aria-label is the name: the visible label first, then the full accessible name
        name: text.fullName(e),
        startDate: e.date,
        endDate: addDays(e.date, 1),
        allDay: true,
        cls: `cash-ev cash-ev--${e.kind}`,
        readOnly: true,
      })),
    [p.events, p.locale],
  );

  const totalsByDay = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const x of p.totals) by.set(x.date, [...(by.get(x.date) ?? []), ...text.dayTotals([x])]);
    return by;
  }, [p.totals, p.locale]);

  const countByDay = useMemo(() => {
    const by = new Map<string, number>();
    for (const e of p.events) by.set(e.date, (by.get(e.date) ?? 0) + 1);
    return by;
  }, [p.events]);

  const month = useMemo((): MonthViewConfig => {
    const eventRenderer: MonthViewConfig["eventRenderer"] = ({ eventRecord, renderData }) => {
      const e: CashEvent | undefined = byId.get(String(eventRecord.id));
      if (e === undefined) return [];
      (renderData.cls as Record<string, boolean>)[`cash-ev--${e.kind}`] = true;
      renderData.showBullet = false;
      renderData.solidBar = true;
      return [{ tag: "span", className: "cash-ev-text", dataset: { cashEvent: e.id }, text: text.label(e) }];
    };
    const dayCellRenderer: MonthViewConfig["dayCellRenderer"] = (cell, dom) => {
      const children = (dom as { children?: unknown }).children;
      if (!Array.isArray(children)) return dom;
      const lines = totalsByDay.get(cell.key) ?? [];
      const n = countByDay.get(cell.key) ?? 0;
      // at the foot of the cell (bryntum-theme.css), so the event bars keep Bryntum's offsets; below 640 px
      // the bars are hidden and only the count shows (the selected day's list opens below the grid)
      if (lines.length > 0)
        (children as DomConfig[]).push({ tag: "span", className: "cash-day-total", text: lines.join(" · ") });
      if (n > 0)
        (children as DomConfig[]).push({
          tag: "span",
          className: "cash-day-count",
          text: `● ${String(n)}`,
          "aria-hidden": "true",
        } as DomConfig);
      return dom;
    };
    return {
      animateTimeShift: !reduced,
      autoRowHeight: true,
      showWeekColumn: false,
      eventHeight: 40,
      eventRenderer,
      dayCellRenderer,
    };
  }, [byId, totalsByDay, countByDay, reduced]);

  const onKeyDownCapture = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-event-id]");
    const e = el === null ? undefined : byId.get(el.dataset["eventId"] ?? "");
    if (e === undefined) return;
    ev.preventDefault();
    ev.stopPropagation();
    p.onSelect(e);
  };

  if (!ready) return null;
  return (
    <div
      className={`cash-bryntum h-[640px] md:h-[720px]${compact ? " cash-compact" : ""}`}
      data-testid="bryntum-calendar"
      data-engine={CASH_CALENDAR_ENGINE.name}
      onKeyDownCapture={onKeyDownCapture}
    >
      <BryntumCalendar
        ariaLabel={t("calendarLabel")}
        date={p.initialDate}
        mode="month"
        modes={{ day: null, week: null, year: null, agenda: null, month }}
        sidebar={false}
        readOnly
        // No `timeZone`: days are already in the workspace zone (M0-09 measured a +1 day shift with it).
        events={events}
        tbar={{
          items: {
            modeSelector: null,
            toggleSidebar: null,
            todayButton: { text: t("today"), ariaLabel: t("today") },
            prevButton: { ariaLabel: t("prev"), tooltip: t("prev") },
            nextButton: { ariaLabel: t("next"), tooltip: t("next") },
          },
        }}
        eventTooltipFeature={false}
        eventMenuFeature={false}
        scheduleMenuFeature={false}
        scheduleTooltipFeature={false}
        eventEditFeature={false}
        dragFeature={false}
        eventCopyPasteFeature={false}
        onEventClick={({ eventRecord }: { eventRecord: EventModel }) => {
          const e = byId.get(String(eventRecord.id));
          if (e !== undefined) p.onSelect(e);
        }}
        onDayNumberClick={({ date }: { date: Date }) => p.onDaySelect?.(ymd(date))}
        onEmptyCellClick={({ date }: { date: Date }) => p.onDaySelect?.(ymd(date))}
        onDateRangeChange={({ new: r }: { new: { startDate: Date; endDate: Date } }) =>
          p.onRangeChange?.(ymd(r.startDate), addDays(ymd(r.endDate), -1))
        }
      />
    </div>
  );
}
