// M3-05 event kinds (cash-calendar.md "Event kinds"): icon + token colours per kind, shared by the list,
// the table and the Bryntum engine (whose CSS classes `cash-ev--<kind>` map to the same tokens).
import type { CashEventKind } from "@cleared/core";
import { AlarmClock, CalendarCheck, CircleCheck, Hourglass, type LucideIcon } from "lucide-react";

export const KIND_STYLE: Record<CashEventKind, { icon: LucideIcon; pill: string }> = {
  estimated_release: {
    icon: Hourglass,
    pill: "bg-status-held-bg text-status-held-fg border-[1.5px] border-dashed border-border-strong",
  },
  dispute_deadline: { icon: AlarmClock, pill: "bg-status-dispute-bg text-status-dispute-fg" },
  released: { icon: CircleCheck, pill: "bg-status-completed-bg text-status-completed-fg" },
  service_completed_due: { icon: CalendarCheck, pill: "bg-status-info-bg text-status-info-fg" },
};
