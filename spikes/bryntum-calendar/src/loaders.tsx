"use client";
// next/dynamic with { ssr: false } must be called from a client component (Next 16 App Router).
// One dynamic() per vendor, so each route's chunk carries only its own calendar library.
import dynamic from "next/dynamic";
import { useState } from "react";
import type { CashCalendarProps } from "./cash-calendar";
import { SPIKE_EVENTS, SPIKE_INITIAL_DATE, SPIKE_LABELS, SPIKE_LOCALE, SPIKE_TIME_ZONE } from "./events";

const loading = () => <p role="status">Loading calendar…</p>;

const Bryntum = dynamic(() => import("./BryntumCashCalendar"), { ssr: false, loading });
const FullCal = dynamic(() => import("./FullCalendarCashCalendar"), { ssr: false, loading });

function useSpikeProps(colorScheme: "light" | "dark"): [CashCalendarProps, string] {
  const [selected, setSelected] = useState("");
  return [
    {
      events: SPIKE_EVENTS,
      locale: SPIKE_LOCALE,
      timeZone: SPIKE_TIME_ZONE,
      initialDate: SPIKE_INITIAL_DATE,
      labels: SPIKE_LABELS,
      colorScheme,
      onSelect: setSelected,
    },
    selected,
  ];
}

function Selected({ id }: { id: string }) {
  return (
    <p data-testid="selected" aria-live="polite">
      Selected: {id || "none"}
    </p>
  );
}

export function BryntumSpike({ colorScheme }: { colorScheme: "light" | "dark" }) {
  const [props, selected] = useSpikeProps(colorScheme);
  return (
    <>
      <div className="cal-host cal-host--fixed">
        <Bryntum {...props} />
      </div>
      <Selected id={selected} />
    </>
  );
}

export function FullCalendarSpike({ colorScheme }: { colorScheme: "light" | "dark" }) {
  const [props, selected] = useSpikeProps(colorScheme);
  return (
    <>
      <div className="cal-host">
        <FullCal {...props} />
      </div>
      <Selected id={selected} />
    </>
  );
}
