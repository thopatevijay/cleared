// The guided Completed step (M3-04, ADR 0017 addendum 2). Service sellers have no tracking number. PayPal
// help129: "We'll release the hold 7 days after you confirm the order status as Completed." PayPal support
// named the web path (Activity → the payment → Completed) and said an API equivalence is "not available".
// So the primary path is a guided web step: the seller's confirmation (a date) sets the estimate to that date
// + 7 days (rule `service_completed`, labelled estimated) and walks the hold to `filed`. The secondary path,
// the approved `record_service_completed` action (legacy trackers-batch COMPLETED), is labelled "Effect on
// release unconfirmed" and never changes the estimate. Pure: no I/O.
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { compareInstants, fromEpochMs, toEpochMs, type Instant } from "../time.ts";
import { SERVICE_COMPLETED_RULE, type HoldEstimate, type HoldType } from "./rules.ts";
import { transitionHold, type HoldEvent, type HoldState } from "./state.ts";

/** What PayPal support wrote to the owner (reply pasted 2026-10-26; docs/research RESEARCH.md log). */
export interface SupportQuote {
  readonly quote: string;
  /** YYYY-MM-DD */
  readonly date: string;
  readonly from: "PayPal support";
}

export const PAYPAL_SUPPORT_QUOTES = {
  /** the web path the guided step follows */
  webPath: {
    quote:
      'For services or intangible items, you can update the order status to "Completed" in your Activity section to help release the hold.',
    date: "2026-10-26",
    from: "PayPal support",
  },
  /** why the API record is labelled "Effect on release unconfirmed" */
  apiUnconfirmed: {
    quote:
      'information confirming that an API-based "Completed" status update is functionally identical to the manual web update is not available.',
    date: "2026-10-26",
    from: "PayPal support",
  },
} as const satisfies Record<string, SupportQuote>;

export const PAYPAL_ENVS = ["sandbox", "live"] as const;
export type PayPalEnv = (typeof PAYPAL_ENVS)[number];

/** The seller's PayPal Activity page on the host for `PAYPAL_ENV`. */
export function paypalActivityUrl(env: PayPalEnv): string {
  const host = env === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
  return `https://${host}/myaccount/activities/`;
}

/** A hold the seller can still confirm: not released, not filed, not past filing. */
export const COMPLETED_CONFIRMABLE_STATES: readonly HoldState[] = [
  "open",
  "explained",
  "action_proposed",
  "approved",
];

export const COMPLETED_REFUSALS = [
  "NOT_SERVICE_HOLD",
  "ALREADY_CONFIRMED",
  "NOT_CONFIRMABLE",
  "DATE_IN_FUTURE",
  "DATE_BEFORE_HOLD",
  "INVALID_DATE",
] as const;
export type CompletedRefusal = (typeof COMPLETED_REFUSALS)[number];

export interface CompletedHoldFacts {
  readonly type: HoldType;
  readonly state: HoldState;
  readonly openedAt: Instant;
  readonly completedConfirmedAt: Instant | null;
}

export interface CompletedConfirmation {
  /** when the seller marked it Completed in PayPal (today → now; an earlier day → noon that day, local) */
  readonly confirmedAt: Instant;
  readonly state: HoldState;
  readonly estimate: HoldEstimate;
  readonly ruleId: typeof SERVICE_COMPLETED_RULE.id;
}

const TO_FILED: readonly HoldEvent[] = ["action_proposed", "action_approved", "action_filed"];

/** Each of proposed → approved → filed the state takes (the same walk as a filed tracking action). */
export function walkToFiled(state: HoldState): HoldState {
  let s = state;
  for (const ev of TO_FILED) {
    const next = transitionHold(s, ev);
    if (next.ok) s = next.value;
  }
  return s;
}

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Instant, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(toEpochMs(at)));
}

/** How far the zone is ahead of UTC at that moment, in ms. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 12:00 on that calendar date in the zone. */
export function localNoon(date: string, timeZone: string): Instant {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 12);
  return fromEpochMs(guess - zoneOffsetMs(guess, timeZone));
}

export const CalendarDateSchema = z.iso.date();

export interface ConfirmInput {
  readonly hold: CompletedHoldFacts;
  /** YYYY-MM-DD in the workspace zone */
  readonly confirmedOn: string;
  readonly now: Instant;
  readonly timeZone: string;
}

/**
 * The seller says "I marked it Completed in PayPal" on `confirmedOn`. Allowed on an unreleased service hold
 * not yet confirmed, for a date from the day the hold opened up to today (workspace zone). The estimate is
 * `service_completed`: the confirmation + 7 days, labelled estimated, with help129 as its source.
 */
export function confirmServiceCompleted(i: ConfirmInput): Result<CompletedConfirmation, CompletedRefusal> {
  const { hold } = i;
  if (hold.type !== "service") return err("NOT_SERVICE_HOLD");
  if (hold.completedConfirmedAt !== null) return err("ALREADY_CONFIRMED");
  if (!COMPLETED_CONFIRMABLE_STATES.includes(hold.state)) return err("NOT_CONFIRMABLE");
  if (!CalendarDateSchema.safeParse(i.confirmedOn).success) return err("INVALID_DATE");
  const today = localDate(i.now, i.timeZone);
  if (i.confirmedOn > today) return err("DATE_IN_FUTURE");
  if (i.confirmedOn < localDate(hold.openedAt, i.timeZone)) return err("DATE_BEFORE_HOLD");
  const noon = localNoon(i.confirmedOn, i.timeZone);
  // today → now; an earlier day → noon that day, but never before the hold opened
  const confirmedAt =
    i.confirmedOn === today ? i.now : compareInstants(noon, hold.openedAt) < 0 ? hold.openedAt : noon;
  const estimate = SERVICE_COMPLETED_RULE.estimate(confirmedAt);
  if (estimate === null) throw new Error("service_completed rule lost its estimate");
  return ok({ confirmedAt, state: walkToFiled(hold.state), estimate, ruleId: SERVICE_COMPLETED_RULE.id });
}

/**
 * The secondary API record (legacy `POST /v1/shipping/trackers-batch`): the capture and status COMPLETED,
 * with no tracking number and no carrier. The ticket asked for `carrier: OTHER`, but PayPal refuses a carrier
 * without a tracking number: live sandbox 400 INVALID_REQUEST / TRACKING_NUMBER_IS_MISSING (debug_id
 * f168737fc6ae4, 2026-11-02), while the M0-04 request without a carrier is accepted. The payload is exactly
 * what is sent. Unknown keys are refused: the approval hash binds every field.
 */
export const RecordServiceCompletedPayloadSchema = z.strictObject({
  capture_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  status: z.literal("COMPLETED"),
});
export type RecordServiceCompletedPayload = z.infer<typeof RecordServiceCompletedPayloadSchema>;

export function recordServiceCompletedPayload(captureId: string): RecordServiceCompletedPayload {
  return RecordServiceCompletedPayloadSchema.parse({ capture_id: captureId, status: "COMPLETED" });
}

/** Where the guided step stands on a service hold (hold.md action slot, M3-04). */
export const COMPLETED_RECORD_STATES = [
  "none",
  "proposed",
  "recording",
  "recorded",
  "failed",
  "unknown",
] as const;

export const CompletedSummarySchema = z.object({
  /** the seller's web-step confirmation */
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  /** PayPal Activity on the host for PAYPAL_ENV */
  activityUrl: z.url(),
  env: z.enum(PAYPAL_ENVS),
  /** the secondary `record_service_completed` action, newest */
  record: z.object({
    state: z.enum(COMPLETED_RECORD_STATES),
    actionId: z.uuid().nullable(),
    /** PayPal's paypal-debug-id of the write, once sent */
    debugId: z.string().nullable(),
    /** the status PayPal reads the tracker back with (COMPLETED in M0-04 and live), once recorded */
    readBack: z.string().nullable(),
    /** the refusal code of a failed record */
    refusal: z.string().nullable(),
  }),
});
export type CompletedSummary = z.infer<typeof CompletedSummarySchema>;

/** The action state → the summary's record state. */
export function completedRecordState(actionState: string | null): CompletedSummary["record"]["state"] {
  switch (actionState) {
    case null:
    case "rejected":
      return "none";
    case "proposed":
      return "proposed";
    case "approved":
    case "executing":
      return "recording";
    case "succeeded":
      return "recorded";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return "none";
  }
}
