// The cash calendar (M3-05, cash-calendar.md): when held money is estimated to free up, what PayPal
// released, and when dispute replies are due, across payments. Pure: the caller passes the workspace's
// holds and disputes; this module picks the range, resolves every day in the workspace time zone and
// totals per day per currency (never across currencies). Release dates are estimates from a cited rule.
import { z } from "zod";
import { AmountSchema, type Amount } from "../contracts/payments.ts";
import { holdRule, type RuleSource } from "../holds/rules.ts";
import { addDays, daysBetween, localDay } from "./days.ts";

// The day arithmetic lives in days.ts (no zod) for the browser (M4-08).
export { addDays, daysBetween, localDay } from "./days.ts";

/** The API caps a range at 92 days (inclusive), about one quarter. */
export const CASH_RANGE_MAX_DAYS = 92;

export const CASH_EVENT_KINDS = [
  "estimated_release",
  "dispute_deadline",
  "released",
  "service_completed_due",
] as const;
export type CashEventKind = (typeof CASH_EVENT_KINDS)[number];

const day = z.iso.date();
const when = z.iso.datetime({ offset: true });

/** `?from=YYYY-MM-DD&to=YYYY-MM-DD`: offset-free days in the workspace zone, `to` included, ≤ 92 days. */
export const CashRangeSchema = z
  .object({ from: day, to: day })
  .strict()
  .refine((r) => r.to >= r.from, { message: "`to` is before `from`", path: ["to"] })
  .refine((r) => daysBetween(r.from, r.to) + 1 <= CASH_RANGE_MAX_DAYS, {
    message: `the range is at most ${String(CASH_RANGE_MAX_DAYS)} days`,
    path: ["to"],
  });
export type CashRange = z.infer<typeof CashRangeSchema>;

/** The default range: the first of the current month in the workspace zone, then 92 days. */
export function defaultCashRange(nowIso: string, timeZone: string): CashRange {
  const from = `${localDay(nowIso, timeZone).slice(0, 8)}01`;
  return { from, to: addDays(from, CASH_RANGE_MAX_DAYS - 1) };
}

const SourceSchema = z.object({
  url: z.url(),
  title: z.string().min(1),
  quote: z.string().min(1),
  retrieved_at: day,
  note: z.string().exactOptional(),
});

export const CashEventSchema = z.object({
  /** `<kind>:<ref id>`: unique in a response */
  id: z.string().min(1),
  kind: z.enum(CASH_EVENT_KINDS),
  /** the day in the workspace zone (all-day; never shifted by the browser's zone) */
  date: day,
  /** the instant behind the day (UTC) */
  at: when,
  amount: AmountSchema,
  /** true for every release date we compute; false for PayPal's own dates (release, reply due) */
  estimated: z.boolean(),
  /** the hold rule an estimate comes from, with its first source; null for PayPal's own dates */
  ruleId: z.string().min(1).nullable(),
  source: SourceSchema.nullable(),
  /** what selecting the event opens: our hold row id or our dispute row id */
  ref: z.object({ type: z.enum(["hold", "dispute"]), id: z.uuid() }),
  /** PayPal's capture reason or dispute status, verbatim */
  detail: z.string().min(1),
});
export type CashEvent = z.infer<typeof CashEventSchema>;

export const CashDayTotalSchema = z.object({
  date: day,
  currency: z.string().min(1),
  /** estimated releases (incl. Completed + 7 days) that day */
  estimated: z.string(),
  /** what PayPal released that day */
  released: z.string(),
  count: z.number().int().min(1),
});
export type CashDayTotal = z.infer<typeof CashDayTotalSchema>;

export const CashCalendarResponseSchema = z.object({
  range: z.object({ from: day, to: day }),
  timezone: z.string().min(1),
  events: z.array(CashEventSchema),
  /** money events only (deadlines excluded), per day and currency */
  totals: z.array(CashDayTotalSchema),
  /** active holds per currency, now (independent of the range) */
  heldNow: z.array(AmountSchema),
  /** active holds whose rule gives no timeline ("No estimate yet") */
  noEstimate: z.array(
    z.object({
      holdId: z.uuid(),
      amount: AmountSchema,
      reason: z.string().min(1),
      ruleId: z.string().min(1),
    }),
  ),
});
export type CashCalendarResponse = z.infer<typeof CashCalendarResponseSchema>;

export interface CashHoldInput {
  readonly id: string;
  readonly amount: Amount;
  readonly state: string;
  readonly reason: string;
  readonly ruleId: string;
  readonly estimatedReleaseAt: string | null;
  readonly releasedAt: string | null;
}

export interface CashDisputeInput {
  readonly id: string;
  readonly status: string;
  readonly dueDate: string | null;
  readonly amount: Amount | null;
}

export interface CashCalendarInput {
  readonly range: CashRange;
  readonly timeZone: string;
  readonly holds: readonly CashHoldInput[];
  readonly disputes: readonly CashDisputeInput[];
  readonly heldNow: readonly Amount[];
}

function firstSource(ruleId: string): RuleSource | null {
  const s = holdRule(ruleId)?.sources[0];
  return s === undefined ? null : { ...s };
}

function holdEvent(h: CashHoldInput, tz: string): CashEvent | null {
  const base = { amount: h.amount, ref: { type: "hold" as const, id: h.id }, detail: h.reason };
  if (h.state === "released") {
    if (h.releasedAt === null) return null;
    const at = h.releasedAt;
    return {
      ...base,
      id: `released:${h.id}`,
      kind: "released",
      date: localDay(at, tz),
      at,
      estimated: false,
      ruleId: null,
      source: null,
    };
  }
  if (h.estimatedReleaseAt === null) return null;
  const at = h.estimatedReleaseAt;
  const kind: CashEventKind =
    h.ruleId === "service_completed" ? "service_completed_due" : "estimated_release";
  return {
    ...base,
    id: `${kind}:${h.id}`,
    kind,
    date: localDay(at, tz),
    at,
    estimated: true,
    ruleId: h.ruleId,
    source: firstSource(h.ruleId),
  };
}

function deadlineEvent(d: CashDisputeInput, tz: string): CashEvent | null {
  if (d.dueDate === null || d.amount === null || d.status === "RESOLVED") return null;
  return {
    id: `dispute_deadline:${d.id}`,
    kind: "dispute_deadline",
    date: localDay(d.dueDate, tz),
    at: d.dueDate,
    amount: d.amount,
    estimated: false,
    ruleId: null,
    source: null,
    ref: { type: "dispute", id: d.id },
    detail: d.status,
  };
}

/** Adds two non-negative decimal strings exactly (PayPal's values; the scale is the longer fraction). */
export function addDecimal(a: string, b: string): string {
  const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
  const minor = (v: string) => {
    const [w = "0", f = ""] = v.split(".");
    return BigInt(w + f.padEnd(scale, "0"));
  };
  const sum = (minor(a) + minor(b)).toString().padStart(scale + 1, "0");
  return scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`;
}

const KIND_ORDER: Record<CashEventKind, number> = {
  dispute_deadline: 0,
  estimated_release: 1,
  service_completed_due: 2,
  released: 3,
};

function dayTotals(events: readonly CashEvent[]): CashDayTotal[] {
  const by = new Map<string, CashDayTotal>();
  for (const e of events) {
    if (e.kind === "dispute_deadline") continue;
    const key = `${e.date}|${e.amount.currency}`;
    const t = by.get(key) ?? {
      date: e.date,
      currency: e.amount.currency,
      estimated: "0",
      released: "0",
      count: 0,
    };
    const released = e.kind === "released";
    by.set(key, {
      ...t,
      estimated: released ? t.estimated : addDecimal(t.estimated, e.amount.value),
      released: released ? addDecimal(t.released, e.amount.value) : t.released,
      count: t.count + 1,
    });
  }
  return [...by.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency),
  );
}

/** The events in the range (days in the workspace zone), their per-day totals, held now and "no estimate". */
export function buildCashCalendar(input: CashCalendarInput): CashCalendarResponse {
  const tz = input.timeZone;
  const { from, to } = input.range;
  const events = [
    ...input.holds.flatMap((h) => holdEvent(h, tz) ?? []),
    ...input.disputes.flatMap((d) => deadlineEvent(d, tz) ?? []),
  ]
    .filter((e) => e.date >= from && e.date <= to)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.amount.currency.localeCompare(b.amount.currency) ||
        a.id.localeCompare(b.id),
    );
  const noEstimate = input.holds
    .filter((h) => h.state !== "released" && h.estimatedReleaseAt === null)
    .map((h) => ({ holdId: h.id, amount: h.amount, reason: h.reason, ruleId: h.ruleId }));
  return CashCalendarResponseSchema.parse({
    range: { from, to },
    timezone: tz,
    events,
    totals: dayTotals(events),
    heldNow: [...input.heldNow],
    noEstimate,
  });
}
