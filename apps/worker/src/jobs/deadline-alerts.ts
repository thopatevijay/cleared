// Deadline alerts (M3-08): the T-72 / T-24 notification a dispute's position calls for, written once per
// (dispute, due date) with its email job, in the caller's transaction. Called by the 15-minute deadline
// watcher and by every dispute sync (deadline-watcher.ts `applyDeadline`). A late tick still alerts for
// the band it lands in; the email states the true remaining time when it is rendered.
import {
  deadlineAlert,
  fromEpochMs,
  storedMoney,
  type NotificationKind,
  type WorkspaceId,
} from "@cleared/core";
import type { Tx } from "@cleared/db";
import { notify, type NotifyDeps } from "../consumers/notifications.ts";

export interface AlertTarget {
  readonly id: string;
  readonly workspaceId: string;
  readonly sellerResponseDueDate: Date | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly reason: string | null;
}

/** Writes the alert `now` calls for; the kind when this call wrote it, null otherwise. */
export async function alertDeadline(
  deps: NotifyDeps,
  tx: Tx,
  d: AlertTarget,
  open: boolean,
  now: Date,
): Promise<NotificationKind | null> {
  const draft = deadlineAlert({
    disputeRowId: d.id,
    dueDate: d.sellerResponseDueDate === null ? null : fromEpochMs(d.sellerResponseDueDate.getTime()),
    open,
    now: fromEpochMs(now.getTime()),
    amount: storedMoney(d.amount, d.currency),
    reason: d.reason,
  });
  if (draft === null) return null;
  const row = await notify(deps, tx, d.workspaceId as WorkspaceId, draft);
  return row === null ? null : draft.kind;
}
