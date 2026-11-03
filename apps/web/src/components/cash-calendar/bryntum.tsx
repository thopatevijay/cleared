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
import { LocaleManager, type DomConfig, type EventModel, type MonthViewConfig } from "@bryntum/calendar";
// the one wrapper we use, not the index (which pulls in all 90 wrappers): `@bryntum/calendar` itself is
// the engine loaded at runtime from our origin (engine.ts, bryntum-runtime.ts; BL-01 6595246110)
import { BryntumCalendar } from "@bryntum/calendar-react/lib/BryntumCalendar.js";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import "@bryntum/calendar/calendar.css";
import "@bryntum/calendar/svalbard-light.css";
import "@bryntum/calendar/fontawesome/css/fontawesome.css";
import "@bryntum/calendar/fontawesome/css/solid.css";
import "./bryntum-theme.css";
import { CASH_CALENDAR_ENGINE } from "../../../config/cash-calendar.ts";
import { addDays } from "@cleared/core";
import { formatAmount } from "../../lib/format.ts";
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

/** A DomConfig's class names, given as a string or as a `{ name: true }` object (Bryntum's child lists hold nulls). */
function classOf(c: DomConfig | null | undefined): string {
  if (c === null || c === undefined || typeof c !== "object") return "";
  const cls = (c as { className?: unknown }).className;
  if (typeof cls === "string") return cls;
  if (cls !== null && typeof cls === "object")
    return Object.entries(cls as Record<string, unknown>)
      .filter(([, on]) => on === true)
      .map(([k]) => k)
      .join(" ");
  return "";
}

/** Below 768 px: Bryntum always draws six week rows; each gets this height, plus the day-name header. */
const COMPACT_ROW_PX = 92;
// day-name header, plus 1 px per row border so six rows never overflow the container
const COMPACT_HEADER_PX = 48 + 8;

const firstOfMonth = (date: string): string => `${date.slice(0, 7)}-01`;

/** `YYYY-MM-01` moved by `n` months. */
function moveMonth(first: string, n: number): string {
  const d = new Date(`${first}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}

/** "November 2026" / "नवंबर 2026" */
const monthTitle = (locale: string, first: string): string =>
  new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
    numberingSystem: "latn",
  }).format(new Date(`${first}T12:00:00Z`));

/** Today, Previous month, Next month (44 px, named at every width) and the month shown (cash-calendar.md rule 4). */
function MonthBar({
  title,
  onToday,
  onMove,
}: {
  title: string;
  onToday: () => void;
  onMove: (n: number) => void;
}) {
  const t = useTranslations("calendar");
  const btn =
    "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-strong bg-surface px-3 font-medium text-accent hover:bg-surface-sunken";
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="month-bar">
      <button type="button" className={btn} onClick={onToday}>
        {t("today")}
      </button>
      <button
        type="button"
        className={btn}
        aria-label={t("prev")}
        onClick={() => {
          onMove(-1);
        }}
      >
        <ChevronLeft aria-hidden="true" size={20} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className={btn}
        aria-label={t("next")}
        onClick={() => {
          onMove(1);
        }}
      >
        <ChevronRight aria-hidden="true" size={20} strokeWidth={1.75} />
      </button>
      <h2 className="ml-1 text-xl font-semibold" aria-live="polite" data-testid="month-title">
        {title}
      </h2>
    </div>
  );
}

/** Below 768 px the month grid shows counts only (cash-calendar.md "375 px"). */
const COMPACT_QUERY = "(max-width: 767px)";

/**
 * Read synchronously on the first render (this module is client-only, `ssr: false`): Bryntum reads its row
 * sizing (`autoRowHeight`, `minRowHeight`) when the view is created and does not re-apply it from later
 * prop changes, so the first render must already know the width class. Crossing the breakpoint re-creates
 * the calendar (`key`).
 */
function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
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
  const [shown, setShown] = useState(() => firstOfMonth(p.initialDate));
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
  const kindsByDay = useMemo(() => {
    const by = new Map<string, Set<string>>();
    for (const e of p.events) by.set(e.date, (by.get(e.date) ?? new Set()).add(e.kind));
    return by;
  }, [p.events]);

  // 375 px cells: "2 · €15.50 · $64.00" (count, then each currency's total, never summed across currencies)
  // spec rule 3: a day's accessible name holds what the cell shows (count and totals), spoken
  const nameByDay = useMemo(() => {
    const by = new Map<string, string>();
    for (const [date, n] of countByDay) {
      const totals = p.totals
        .filter((x) => x.date === date)
        .flatMap((x) => [
          ...(x.estimated === "0"
            ? []
            : [
                t("dayEstimated", {
                  amount: formatAmount(p.locale, { value: x.estimated, currency: x.currency }).spoken,
                }),
              ]),
          ...(x.released === "0"
            ? []
            : [
                t("dayReleased", {
                  amount: formatAmount(p.locale, { value: x.released, currency: x.currency }).spoken,
                }),
              ]),
        ]);
      by.set(date, [text.dayLong(date), t("dayEvents", { count: n }), ...totals].join(", "));
    }
    return by;
  }, [countByDay, p.totals, p.locale]);

  const shortByDay = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const x of p.totals) {
      const value = x.estimated === "0" ? x.released : x.estimated;
      by.set(x.date, [...(by.get(x.date) ?? []), text.short({ value, currency: x.currency })]);
    }
    return by;
  }, [p.totals, p.locale]);

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
      const short = shortByDay.get(cell.key) ?? [];
      const n = countByDay.get(cell.key) ?? 0;
      const header = (children as DomConfig[]).find((c) => classOf(c).includes("b-cal-cell-header"));
      const into = (header as { children?: unknown } | undefined)?.children;
      const target = Array.isArray(into) ? (into as DomConfig[]) : (children as DomConfig[]);
      // wide: "€15.50 · $64.00" at the left of the header (full words are on the bars and in the day list);
      // below 1024 px the bars are hidden and the cell shows the count, then one total per currency
      if (short.length > 0)
        target.unshift({ tag: "span", className: "cash-day-total", text: short.join(" · ") });
      if (n > 0)
        (children as DomConfig[]).push({
          tag: "span",
          className: "cash-day-count",
          children: [
            {
              tag: "span",
              className: "cash-day-n",
              children: [
                ...[...(kindsByDay.get(cell.key) ?? [])].map((k) => ({
                  tag: "i",
                  className: `cash-dot cash-dot--${k}`,
                })),
                { tag: "b", text: String(n) },
              ],
            },
            ...short.map((line) => ({ tag: "span", text: line })),
          ],
        });
      const spoken = nameByDay.get(cell.key);
      const dayNum = (Array.isArray(into) ? (into as DomConfig[]) : []).find(
        (c) => classOf(c).includes("b-day-name"), // the day-number link (Bryntum adds `b-day-num` after the renderer)
      );
      if (spoken !== undefined) {
        // the focusable day number (Bryntum's link) and the grid cell both carry it
        if (dayNum !== undefined) (dayNum as Record<string, unknown>)["aria-label"] = spoken;
        (dom as Record<string, unknown>)["aria-label"] = spoken;
      }
      if (p.selectedDay === cell.key)
        (dom as { className?: Record<string, boolean> }).className = {
          ...((dom as { className?: Record<string, boolean> }).className ?? {}),
          "cash-selected": true,
        };
      return dom;
    };
    return {
      animateTimeShift: !reduced,
      // below 768 px the bars are hidden: six equal rows that always fit the container (no inner scroll
      // hides the last week); wider, rows grow with their bars
      autoRowHeight: !compact,
      ...(compact ? { minRowHeight: COMPACT_ROW_PX } : {}),
      showWeekColumn: false,
      eventHeight: 60,
      eventRenderer,
      dayCellRenderer,
    };
  }, [byId, totalsByDay, countByDay, kindsByDay, shortByDay, nameByDay, p.selectedDay, reduced, compact]);

  useEffect(() => {
    if (ready) p.onEngineReady?.();
  }, [ready, p]);

  const onKeyDownCapture = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const day = (ev.target as HTMLElement).closest<HTMLElement>(".b-day-num[data-header-date]");
    if (day !== null) {
      ev.preventDefault();
      ev.stopPropagation();
      p.onDaySelect?.(day.dataset["headerDate"] ?? "");
      return;
    }
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-event-id]");
    const e = el === null ? undefined : byId.get(el.dataset["eventId"] ?? "");
    if (e === undefined) return;
    ev.preventDefault();
    ev.stopPropagation();
    p.onSelect(e);
  };

  if (!ready) return null;
  return (
    <div className="flex flex-col gap-3">
      <MonthBar
        title={monthTitle(p.locale, shown)}
        onToday={() => {
          setShown(firstOfMonth(p.initialDate));
        }}
        onMove={(n) => {
          setShown(moveMonth(shown, n));
        }}
      />
      <div
        className={`cash-bryntum${compact ? " cash-compact" : " md:h-[640px] xl:h-[720px]"}`}
        style={compact ? { height: `${String(COMPACT_HEADER_PX + 6 * COMPACT_ROW_PX)}px` } : undefined}
        data-testid="bryntum-calendar"
        data-engine={CASH_CALENDAR_ENGINE.name}
        onKeyDownCapture={onKeyDownCapture}
      >
        <BryntumCalendar
          key={compact ? "compact" : "wide"}
          ariaLabel={t("calendarLabel")}
          date={shown}
          mode="month"
          modes={{ day: null, week: null, year: null, agenda: null, month }}
          sidebar={false}
          readOnly
          // No `timeZone`: days are already in the workspace zone (M0-09 measured a +1 day shift with it).
          // Below 768 px no bars are drawn (the cells show counts and totals from our own renderer), so the
          // engine gets no events to lay out: a row with events would otherwise grow by its hidden bars and
          // squeeze the other rows of the fixed-height grid.
          events={compact ? [] : events}
          tbar={null}
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
    </div>
  );
}
