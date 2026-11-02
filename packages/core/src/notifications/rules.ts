// Notification rules (M3-08, ADR 0015): which notification an event or a clock tick calls for, and the
// dedupe key that makes each one happen once. Pure: the clock is an argument.
//
// The dedupe key is (workspace, kind, ref_id, threshold); the workspace is the unique index's first column,
// so the key string carries the other three. A deadline's threshold names the due date it was computed
// against, so a NEW `seller_response_due_date` on the same dispute gets its own T-72/T-24 alerts
// (BL-01 6536548146), while repeated ticks against the same date add none.
import { z } from "zod";
import { evaluateDeadline } from "../disputes/deadline.ts";
import { MoneySchema, parseMoney, type Money } from "../money.ts";
import { addMinutes, compareInstants, InstantSchema, type Instant } from "../time.ts";

export const NOTIFICATION_KINDS = [
  "hold_opened",
  "dispute_opened",
  "deadline_t72",
  "deadline_t24",
  "completed_reminder",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a notification links to (our row ids, never PayPal's). */
export const NOTIFICATION_REF_TYPES = ["hold", "dispute", "payment"] as const;
export type NotificationRefType = (typeof NOTIFICATION_REF_TYPES)[number];

/** The template inputs stored with a notification. Never evidence text or buyer messages. */
export const NotificationDataSchema = z.object({
  amount: MoneySchema.nullable(),
  /** PayPal's reason code (hold `status_details.reason`, dispute `reason`) */
  reason: z.string().max(120).nullable(),
  dueDate: InstantSchema.nullable(),
  /** completed_reminder: the estimated release date */
  releaseDate: InstantSchema.nullable(),
  /** the payment a hold or reminder links to */
  paymentId: z.uuid().nullable(),
});
export type NotificationData = z.infer<typeof NotificationDataSchema>;

export interface NotificationDraft {
  readonly kind: NotificationKind;
  readonly refType: NotificationRefType;
  readonly refId: string;
  /** "once" for one-time events; the deadline's due date for deadline alerts */
  readonly threshold: string;
  readonly data: NotificationData;
}

const EMPTY: NotificationData = {
  amount: null,
  reason: null,
  dueDate: null,
  releaseDate: null,
  paymentId: null,
};

/** A stored amount + currency as Money, or null when either is missing or invalid (the copy then omits it). */
export function storedMoney(amount: string | null, currency: string | null): Money | null {
  if (amount === null || currency === null) return null;
  const parsed = parseMoney(amount, currency);
  return parsed.ok ? parsed.value : null;
}

/** A stored row as template input; null for an unknown kind. Rows from before M3-08 have `{}` data. */
export function storedNotification(row: {
  readonly id: string;
  readonly kind: string;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly disputeId: string | null;
  readonly data: unknown;
}): Pick<NotificationDraft, "kind" | "refType" | "refId" | "data"> | null {
  const kind = NOTIFICATION_KINDS.find((k) => k === row.kind);
  if (kind === undefined) return null;
  const refType = NOTIFICATION_REF_TYPES.find((t) => t === row.refType) ?? "dispute";
  const data = NotificationDataSchema.safeParse({ ...EMPTY, ...(row.data as object | null) });
  return {
    kind,
    refType,
    refId: row.refId ?? row.disputeId ?? row.id,
    data: data.success ? data.data : EMPTY,
  };
}

export function dedupeKey(d: Pick<NotificationDraft, "kind" | "refId" | "threshold">): string {
  return `${d.kind}:${d.refId}:${d.threshold}`;
}

/** `hold.opened`: money held on a capture. */
export function holdOpenedNotification(input: {
  readonly holdId: string;
  readonly paymentId: string;
  readonly amount: Money | null;
  readonly reason: string;
}): NotificationDraft {
  return {
    kind: "hold_opened",
    refType: "hold",
    refId: input.holdId,
    threshold: "once",
    data: { ...EMPTY, amount: input.amount, reason: input.reason, paymentId: input.paymentId },
  };
}

/** `dispute.opened`: a buyer opened a case. */
export function disputeOpenedNotification(input: {
  readonly disputeRowId: string;
  readonly amount: Money | null;
  readonly reason: string | null;
  readonly dueDate: Instant | null;
}): NotificationDraft {
  return {
    kind: "dispute_opened",
    refType: "dispute",
    refId: input.disputeRowId,
    threshold: "once",
    data: { ...EMPTY, amount: input.amount, reason: input.reason, dueDate: input.dueDate },
  };
}

/**
 * The deadline alert `now` calls for (T-72 inside 72 h, T-24 inside 24 h, none past due − 1 h), keyed on
 * the due date. A late tick still returns the alert for the band it lands in; the template states the
 * true remaining time.
 */
export function deadlineAlert(input: {
  readonly disputeRowId: string;
  readonly dueDate: Instant | null;
  readonly open: boolean;
  readonly now: Instant;
  readonly amount: Money | null;
  readonly reason: string | null;
}): NotificationDraft | null {
  const evaluation = evaluateDeadline({ dueDate: input.dueDate, open: input.open, now: input.now });
  if (evaluation?.notify == null || input.dueDate === null) return null;
  return {
    kind: evaluation.notify,
    refType: "dispute",
    refId: input.disputeRowId,
    threshold: input.dueDate,
    data: { ...EMPTY, amount: input.amount, reason: input.reason, dueDate: input.dueDate },
  };
}

/** M3-04 marks an order Completed; 7 days later the seller gets one reminder. */
export const COMPLETED_REMINDER_DAYS = 7;

export function completedReminder(input: {
  readonly paymentId: string;
  readonly completedAt: Instant;
  readonly now: Instant;
  readonly amount: Money | null;
  readonly releaseDate: Instant | null;
}): NotificationDraft | null {
  const due = addMinutes(input.completedAt, COMPLETED_REMINDER_DAYS * 24 * 60);
  if (compareInstants(input.now, due) < 0) return null;
  return {
    kind: "completed_reminder",
    refType: "payment",
    refId: input.paymentId,
    threshold: input.completedAt,
    data: { ...EMPTY, amount: input.amount, releaseDate: input.releaseDate, paymentId: input.paymentId },
  };
}

/** The app path (without locale) a notification opens. */
export function notificationPath(n: {
  readonly refType: NotificationRefType;
  readonly refId: string;
  readonly data: NotificationData;
}): string {
  if (n.refType === "dispute") return `/disputes/${n.refId}`;
  if (n.refType === "payment") return `/payments/${n.refId}`;
  return n.data.paymentId === null ? "/payments" : `/payments/${n.data.paymentId}`;
}
