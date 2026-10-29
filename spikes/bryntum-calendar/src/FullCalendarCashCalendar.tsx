"use client";
// FullCalendar v7 implementation of CashCalendar. Client-only: loaded through next/dynamic { ssr: false }.
// v7 ships the views as subpaths of @fullcalendar/react (no separate @fullcalendar/daygrid package).
import { useMemo } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import { type CashCalendarProps, eventText } from "./cash-calendar";

export default function FullCalendarCashCalendar(p: CashCalendarProps) {
  const byId = useMemo(() => new Map(p.events.map((e) => [e.id, e])), [p.events]);
  const events = useMemo(
    () => p.events.map((e) => ({ id: e.id, title: eventText(e, p.locale), start: e.date, allDay: true })),
    [p.events, p.locale],
  );
  return (
    <div data-color-scheme={p.colorScheme ?? "light"} aria-label={p.labels.calendar} role="region">
      <FullCalendar
        plugins={[dayGridPlugin, classicThemePlugin]}
        initialView="dayGridMonth"
        initialDate={p.initialDate ?? p.events[0]?.date}
        timeZone={p.timeZone}
        locale={p.locale}
        height="auto"
        events={events}
        eventClick={(info) => p.onSelect?.(info.event.id)}
        eventContent={(info) => {
          const e = byId.get(info.event.id);
          if (!e) return null;
          return (
            <span data-cash-event={e.id} className="fc-cash">
              {eventText(e, p.locale)}
              {e.estimated ? <span className="est-badge">{p.labels.estimated}</span> : null}
            </span>
          );
        }}
      />
    </div>
  );
}
