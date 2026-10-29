"use client";
// Bryntum implementation of CashCalendar. Client-only: loaded through next/dynamic { ssr: false }.
import { useEffect, useMemo, useState } from "react";
import { BryntumCalendar } from "@bryntum/calendar-react";
import type { DomConfig, EventModel } from "@bryntum/calendar";
import "@bryntum/calendar/calendar.css";
import "@bryntum/calendar/svalbard-light.css";
import "@bryntum/calendar/fontawesome/css/fontawesome.css";
import "@bryntum/calendar/fontawesome/css/solid.css";
import { type CashCalendarProps, type ReleaseEvent, eventText } from "./cash-calendar";

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// DomConfig with `text` (textContent), never a string: a string return is inserted as innerHTML.
function renderEvent(byId: Map<string, ReleaseEvent>, p: CashCalendarProps) {
  return ({ eventRecord }: { eventRecord: EventModel }): DomConfig[] => {
    const e = byId.get(String(eventRecord.id));
    if (!e) return [];
    const parts: DomConfig[] = [{ tag: "span", dataset: { cashEvent: e.id }, text: eventText(e, p.locale) }];
    if (e.estimated) parts.push({ tag: "span", className: "est-badge", text: p.labels.estimated });
    return parts;
  };
}

export default function BryntumCashCalendar(p: CashCalendarProps) {
  const [darkLoaded, setDarkLoaded] = useState(p.colorScheme !== "dark");
  useEffect(() => {
    if (p.colorScheme === "dark") {
      // Bryntum 7 themes are :root variable sets; the dark one loaded after the light one wins.
      void import("@bryntum/calendar/svalbard-dark.css").then(() => setDarkLoaded(true));
    }
  }, [p.colorScheme]);

  const byId = useMemo(() => new Map(p.events.map((e) => [e.id, e])), [p.events]);
  const events = useMemo(
    () =>
      p.events.map((e) => ({
        id: e.id,
        name: eventText(e, p.locale),
        startDate: e.date,
        endDate: nextDay(e.date),
        allDay: true,
      })),
    [p.events, p.locale],
  );
  const modeDefaults = useMemo(() => ({ eventRenderer: renderEvent(byId, p) }), [byId, p]);

  if (!darkLoaded) return null;
  return (
    <BryntumCalendar
      ariaLabel={p.labels.calendar}
      date={p.initialDate ?? p.events[0]?.date ?? new Date()}
      mode="month"
      modes={{ day: null, week: null, year: null, agenda: null }}
      sidebar={false}
      readOnly
      // No `timeZone={p.timeZone}`: with it, all-day events moved +1 day in an America/Los_Angeles
      // browser (measured, M0-09). `date` is already the day in the workspace zone, so it is passed as is.
      events={events}
      modeDefaults={modeDefaults}
      onEventClick={({ eventRecord }) => p.onSelect?.(String(eventRecord.id))}
    />
  );
}
