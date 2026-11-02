// Disputes (M2-06): the PayPal mirror's finder, the deadline watcher's one-time alerts and state, and the
// watcher's cross-workspace scan. The scoped part joins `forWorkspace(db, ws).disputes`; the scan is a
// platform read (`platform(db).disputeDeadlines`) because the cron job runs for every workspace.
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import type { DeadlineState } from "@cleared/core";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { findOneInScope, mutableScopedRepo, type Row } from "./scoped.ts";

export type DisputeRow = Row<typeof s.disputes>;

export function disputesRepo(db: Db, ws: string) {
  return {
    ...mutableScopedRepo(db, s.disputes, ws),
    getByDisputeId: (disputeId: string, tx?: Executor): Promise<DisputeRow | null> =>
      findOneInScope(tx ?? db, s.disputes, ws, s.disputes.disputeId, disputeId),
    /** Sets `deadline_state`; true when it changed. */
    async setDeadlineState(id: string, state: DeadlineState, tx?: Executor): Promise<boolean> {
      const rows = await (tx ?? db)
        .update(s.disputes)
        .set({ deadlineState: state })
        .where(
          and(eq(s.disputes.workspaceId, ws), eq(s.disputes.id, id), ne(s.disputes.deadlineState, state)),
        )
        .returning({ id: s.disputes.id });
      return rows.length > 0;
    },
    /** The dispute's notifications (oldest first). */
    async notificationsFor(disputeRowId: string, tx?: Executor): Promise<Row<typeof s.notifications>[]> {
      return (tx ?? db)
        .select()
        .from(s.notifications)
        .where(and(eq(s.notifications.workspaceId, ws), eq(s.notifications.disputeId, disputeRowId)))
        .orderBy(asc(s.notifications.createdAt));
    },
  };
}

export interface WatchedDispute {
  readonly id: string;
  readonly workspaceId: string;
  readonly disputeId: string;
  readonly status: string;
  readonly sellerResponseDueDate: Date;
  readonly deadlineState: DeadlineState;
}

/** Platform read for the deadline watcher: every unresolved dispute with a due date, in every workspace. */
export function disputeDeadlinesRepo(db: Db) {
  return {
    async watched(limit = 500, tx?: Executor): Promise<WatchedDispute[]> {
      const rows = await (tx ?? db)
        .select({
          id: s.disputes.id,
          workspaceId: s.disputes.workspaceId,
          disputeId: s.disputes.disputeId,
          status: s.disputes.status,
          sellerResponseDueDate: s.disputes.sellerResponseDueDate,
          deadlineState: s.disputes.deadlineState,
        })
        .from(s.disputes)
        .where(
          and(
            ne(s.disputes.status, "RESOLVED"),
            isNotNull(s.disputes.sellerResponseDueDate),
            // closed_for_action is final for a due date; a sync with a new due date re-evaluates it
            ne(s.disputes.deadlineState, "closed_for_action"),
          ),
        )
        .orderBy(asc(s.disputes.sellerResponseDueDate))
        .limit(Math.max(1, Math.min(5_000, Math.trunc(limit))));
      return rows.flatMap((r) =>
        r.sellerResponseDueDate === null ? [] : [{ ...r, sellerResponseDueDate: r.sellerResponseDueDate }],
      );
    },
  };
}
