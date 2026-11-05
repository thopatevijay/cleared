import type { ReleaseEvent } from "./cash-calendar";

// Six synthetic expected-release events (data policy: all personal data is synthetic).
// Two share a day on purpose, to see how each calendar stacks events in a month cell.
export const SPIKE_EVENTS: readonly ReleaseEvent[] = [
  {
    id: "SYN-CAP-001",
    date: "2026-11-04",
    amount: "240.00",
    currency: "USD",
    label: "Logo pack #1042",
    estimated: true,
  },
  {
    id: "SYN-CAP-002",
    date: "2026-11-09",
    amount: "1180.50",
    currency: "USD",
    label: "Website build #1051",
    estimated: true,
  },
  {
    id: "SYN-CAP-003",
    date: "2026-11-09",
    amount: "95.00",
    currency: "EUR",
    label: "Translation #1053",
    estimated: true,
  },
  {
    id: "SYN-CAP-004",
    date: "2026-11-17",
    amount: "410.00",
    currency: "GBP",
    label: "Illustrations #1060",
    estimated: true,
  },
  {
    id: "SYN-CAP-005",
    date: "2026-11-23",
    amount: "760.25",
    currency: "USD",
    label: "App icons #1064",
    estimated: false,
  },
  {
    id: "SYN-CAP-006",
    date: "2026-11-30",
    amount: "52.00",
    currency: "AUD",
    label: "Copy edit #1071",
    estimated: true,
  },
];

export const SPIKE_INITIAL_DATE = "2026-11-01";
export const SPIKE_LOCALE = "en-IN";
export const SPIKE_TIME_ZONE = "Asia/Kolkata";
export const SPIKE_LABELS = { calendar: "Expected releases", estimated: "estimated" };
