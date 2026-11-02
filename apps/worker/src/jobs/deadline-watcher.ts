// Deadline watcher (M2-06): every 15 minutes, and on each dispute sync, place every open dispute against
// its `seller_response_due_date` (core `evaluateDeadline`) and
// - set `disputes.deadline_state` (ok | t72 | t24 | closed_for_action at due − 1 h)
// - write the `deadline_t72` / `deadline_t24` notification once per (dispute, due date), with its email job
//   (M3-08, deadline-alerts.ts).
// The cron tick is a plain pg-boss job (like the outbox relay): no envelope, nothing to dedupe; each
// dispute is applied in its own transaction so one failure never blocks the rest.
import {
  evaluateDeadline,
  fromEpochMs,
  isDisputeOpen,
  mapDisputeState,
  type DeadlineState,
  type NotificationKind,
  type WorkspaceId,
} from "@cleared/core";
import type { Logger } from "@cleared/adapters";
import {
  DISPUTE_DEADLINE_WATCH_CRON,
  DISPUTE_DEADLINE_WATCH_QUEUE,
  ensureQueue,
  forWorkspace,
  platform,
  queueSpec,
  withTransaction,
  type Db,
  type Publisher,
  type Queue,
  type Tx,
} from "@cleared/db";
import type { NotifyDeps } from "../consumers/notifications.ts";
import { alertDeadline, type AlertTarget } from "./deadline-alerts.ts";

export interface DeadlineTarget extends AlertTarget {
  readonly status: string;
}

export interface DeadlineApplied {
  readonly state: DeadlineState;
  readonly notified: NotificationKind | null;
}

/** Applies the deadline position at `now` to one stored dispute (state + one-time alert with its email job). */
export async function applyDeadline(
  deps: NotifyDeps,
  d: DeadlineTarget,
  now: Date,
  tx: Tx,
): Promise<DeadlineApplied> {
  const repo = forWorkspace(deps.db, d.workspaceId as WorkspaceId).disputes;
  const open = isDisputeOpen(mapDisputeState({ status: d.status, stage: null, outcomeCode: null }));
  const evaluation = evaluateDeadline({
    dueDate: d.sellerResponseDueDate === null ? null : fromEpochMs(d.sellerResponseDueDate.getTime()),
    open,
    now: fromEpochMs(now.getTime()),
  });
  // Not watched (no due date, or resolved): nothing is pending against a deadline.
  const state = evaluation?.state ?? "ok";
  await repo.setDeadlineState(d.id, state, tx);
  const notified = await alertDeadline(deps, tx, d, open, now);
  return { state, notified };
}

export interface WatchResult {
  readonly scanned: number;
  readonly notified: number;
  readonly failed: number;
}

/** One watcher tick over every open dispute with a due date. */
export async function runDeadlineWatch(deps: {
  db: Db;
  publisher: Publisher;
  now: () => Date;
  log: Logger;
}): Promise<WatchResult> {
  const watched = await platform(deps.db).disputeDeadlines.watched();
  let notified = 0;
  let failed = 0;
  for (const d of watched) {
    try {
      const r = await withTransaction(deps.db, (tx) => applyDeadline(deps, d, deps.now(), tx));
      if (r.notified !== null) {
        notified += 1;
        deps.log.info(
          { disputeId: d.disputeId, workspaceId: d.workspaceId, kind: r.notified },
          "deadline alert",
        );
      }
    } catch (error) {
      failed += 1;
      deps.log.error({ disputeId: d.disputeId, err: error }, "deadline watcher: dispute failed");
    }
  }
  return { scanned: watched.length, notified, failed };
}

/** Schedules the watcher every 15 minutes and consumes its ticks (every worker; pg-boss runs one per tick). */
export async function scheduleDeadlineWatch(deps: {
  db: Db;
  boss: Queue;
  publisher: Publisher;
  log: Logger;
  now: () => Date;
  pollingIntervalSeconds?: number;
}): Promise<void> {
  const spec = queueSpec(DISPUTE_DEADLINE_WATCH_QUEUE);
  await ensureQueue(deps.boss, spec);
  await deps.boss.schedule(spec.name, DISPUTE_DEADLINE_WATCH_CRON);
  await deps.boss.work(
    spec.name,
    deps.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: deps.pollingIntervalSeconds },
    async () => {
      const result = await runDeadlineWatch(deps);
      deps.log.info(result, "deadline watcher tick");
    },
  );
}
