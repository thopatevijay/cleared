// Notification consumers (M3-08). `notify` writes one notification row (once per dedupe key) and, in the
// same transaction, its `notification.send_email` job, so the in-app row and the email attempt commit
// together. The `hold.opened` and `dispute.opened` handlers build the row from the stored mirror (amount,
// reason code, due date only: never evidence text or buyer messages).
import {
  disputeOpenedNotification,
  DisputeOpenedEvent,
  fromEpochMs,
  holdOpenedNotification,
  HoldOpenedEvent,
  storedMoney,
  type NotificationDraft,
  type WorkspaceId,
} from "@cleared/core";
import {
  forWorkspace,
  NOTIFICATION_SEND_EMAIL_QUEUE,
  type Db,
  type NotificationRow,
  type Publisher,
  type Tx,
} from "@cleared/db";
import type { Handler } from "../consume.ts";

export interface NotifyDeps {
  readonly db: Db;
  readonly publisher: Publisher;
}

/** The send job's data. */
export interface SendEmailData {
  readonly notificationId: string;
  readonly workspaceId: string;
}

/** Inserts the notification unless its dedupe key exists; a new row enqueues its email job in `tx`. */
export async function notify(
  deps: NotifyDeps,
  tx: Tx,
  ws: WorkspaceId,
  draft: NotificationDraft,
): Promise<NotificationRow | null> {
  const row = await forWorkspace(deps.db, ws).notifications.insertOnce(draft, tx);
  if (row === null) return null;
  const data: SendEmailData = { notificationId: row.id, workspaceId: ws };
  // the notification id is the message id (consumer dedupe) and the job id (one job per notification)
  await deps.publisher.enqueue(tx, NOTIFICATION_SEND_EMAIL_QUEUE, data, {
    messageId: row.id,
    jobId: row.id,
    workspaceId: ws,
  });
  return row;
}

/** `hold.opened` → `hold_opened`. */
export function holdOpenedHandler(deps: NotifyDeps): Handler {
  return async (data, { tx, log }) => {
    const e = HoldOpenedEvent.parse(data);
    const repos = forWorkspace(deps.db, e.workspaceId);
    const hold = await repos.holds.get(e.data.holdId, tx);
    if (hold === null) {
      log.warn({ holdId: e.data.holdId }, "hold notification: hold not found");
      return;
    }
    const payment = await repos.payments.get(hold.paymentId, tx);
    const draft = holdOpenedNotification({
      holdId: hold.id,
      paymentId: hold.paymentId,
      amount: payment === null ? null : storedMoney(payment.amount, payment.currency),
      reason: e.data.reason,
    });
    const row = await notify(deps, tx, e.workspaceId, draft);
    log.info({ holdId: hold.id, notificationId: row?.id ?? null }, "hold notification");
  };
}

/** `dispute.opened` → `dispute_opened`. */
export function disputeOpenedHandler(deps: NotifyDeps): Handler {
  return async (data, { tx, log }) => {
    const e = DisputeOpenedEvent.parse(data);
    const d = await forWorkspace(deps.db, e.workspaceId).disputes.getByDisputeId(e.data.disputeId, tx);
    if (d === null) {
      log.warn({ disputeId: e.data.disputeId }, "dispute notification: dispute not found");
      return;
    }
    const draft = disputeOpenedNotification({
      disputeRowId: d.id,
      amount: storedMoney(d.amount, d.currency),
      reason: d.reason,
      dueDate: d.sellerResponseDueDate === null ? null : fromEpochMs(d.sellerResponseDueDate.getTime()),
    });
    const row = await notify(deps, tx, e.workspaceId, draft);
    log.info({ disputeId: e.data.disputeId, notificationId: row?.id ?? null }, "dispute notification");
  };
}

/** Runs each handler in order in the same delivery (one queue, one entry: BL-01 6538667217). */
export function allOf(...handlers: readonly Handler[]): Handler {
  return async (data, ctx) => {
    for (const h of handlers) await h(data, ctx);
  };
}
