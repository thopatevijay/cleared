// M3-08 AC 1: the threshold logic fires T-72 and T-24 exactly once each for a dispute due in 80 h, across
// simulated 15-minute ticks (time injected). Plus the dedupe key: a renewed due date gets its own alerts
// (BL-01 6536548146), a late tick still alerts, and one-time events key on "once".
import { describe, expect, it } from "vitest";
import { addMinutes, type Instant } from "../time.ts";
import {
  completedReminder,
  deadlineAlert,
  dedupeKey,
  disputeOpenedNotification,
  holdOpenedNotification,
  notificationPath,
  NotificationDataSchema,
} from "./rules.ts";

const START = "2026-11-01T00:00:00.000Z" as Instant;
const DISPUTE = "6f0b8e43-3f0e-4c69-9a0e-6f3d1b4b9a11";
const usd = { amount: "120.00", currency: "USD" } as const;

/** Runs the watcher's rule every 15 minutes from `from` to `until`, deduping like the unique index. */
function ticks(due: Instant, from: Instant, minutes: number, seen = new Set<string>()): string[] {
  const fired: string[] = [];
  for (let t = 0; t <= minutes; t += 15) {
    const now = addMinutes(from, t);
    const alert = deadlineAlert({
      disputeRowId: DISPUTE,
      dueDate: due,
      open: true,
      now,
      amount: usd,
      reason: null,
    });
    if (alert === null) continue;
    const key = dedupeKey(alert);
    if (seen.has(key)) continue;
    seen.add(key);
    fired.push(`${alert.kind}@${String(t)}`);
  }
  return fired;
}

describe("deadlineAlert across 15-minute ticks", () => {
  it("a dispute due in 80 h fires T-72 once (at 8 h) and T-24 once (at 56 h), nothing else", () => {
    const due = addMinutes(START, 80 * 60);
    expect(ticks(due, START, 80 * 60 + 120)).toEqual(["deadline_t72@480", "deadline_t24@3360"]);
  });

  it("a renewed due date on the same dispute gets its own T-72 and T-24", () => {
    const seen = new Set<string>();
    const first = addMinutes(START, 80 * 60);
    expect(ticks(first, START, 60 * 60, seen)).toHaveLength(2);
    const renewed = addMinutes(START, 60 * 60 + 96 * 60);
    expect(ticks(renewed, addMinutes(START, 60 * 60), 96 * 60, seen)).toEqual([
      "deadline_t72@1440",
      "deadline_t24@4320",
    ]);
  });

  it("a late first tick inside 24 h fires T-24 only; past due − 1 h and closed disputes fire nothing", () => {
    const due = addMinutes(START, 20 * 60);
    expect(ticks(due, START, 24 * 60)).toEqual(["deadline_t24@0"]);
    const closed = deadlineAlert({
      disputeRowId: DISPUTE,
      dueDate: due,
      open: false,
      now: START,
      amount: null,
      reason: null,
    });
    expect(closed).toBeNull();
    const noDue = deadlineAlert({
      disputeRowId: DISPUTE,
      dueDate: null,
      open: true,
      now: START,
      amount: null,
      reason: null,
    });
    expect(noDue).toBeNull();
  });

  it("keys on (kind, ref, due date) and stores only amount, reason and dates", () => {
    const due = addMinutes(START, 30 * 60);
    const a = deadlineAlert({
      disputeRowId: DISPUTE,
      dueDate: due,
      open: true,
      now: START,
      amount: usd,
      reason: "X",
    });
    expect(a && dedupeKey(a)).toBe(`deadline_t72:${DISPUTE}:${due}`);
    expect(NotificationDataSchema.parse(a?.data)).toEqual(a?.data);
  });
});

describe("one-time events and links", () => {
  it("hold_opened and dispute_opened key on 'once' and link to the payment / dispute", () => {
    const pay = "1b4b9a11-3f0e-4c69-9a0e-6f3d6f0b8e43";
    const h = holdOpenedNotification({
      holdId: DISPUTE,
      paymentId: pay,
      amount: usd,
      reason: "PENDING_REVIEW",
    });
    expect(dedupeKey(h)).toBe(`hold_opened:${DISPUTE}:once`);
    expect(notificationPath(h)).toBe(`/payments/${pay}`);
    const d = disputeOpenedNotification({ disputeRowId: DISPUTE, amount: usd, reason: null, dueDate: null });
    expect(dedupeKey(d)).toBe(`dispute_opened:${DISPUTE}:once`);
    expect(notificationPath(d)).toBe(`/disputes/${DISPUTE}`);
  });

  it("completed_reminder fires from Completed + 7 days, keyed on the completion time", () => {
    const pay = "1b4b9a11-3f0e-4c69-9a0e-6f3d6f0b8e43";
    const input = { paymentId: pay, completedAt: START, amount: usd, releaseDate: null };
    expect(completedReminder({ ...input, now: addMinutes(START, 7 * 24 * 60 - 1) })).toBeNull();
    const r = completedReminder({ ...input, now: addMinutes(START, 7 * 24 * 60) });
    expect(r && dedupeKey(r)).toBe(`completed_reminder:${pay}:${START}`);
    expect(r && notificationPath(r)).toBe(`/payments/${pay}`);
  });
});
