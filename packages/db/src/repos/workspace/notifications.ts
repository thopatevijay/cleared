// Notifications (M3-08): one row per (workspace, dedupe key) written by the event consumers and the deadline
// watcher, read and marked read by the in-app centre, and updated with the email result by the send job.
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { dedupeKey, type NotificationDraft } from "@cleared/core";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { mutableScopedRepo, type Row } from "./scoped.ts";

export type NotificationRow = Row<typeof s.notifications>;

export const EMAIL_STATUSES = ["sent", "refused", "no_recipient", "failed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** The centre's page size (the panel shows the latest 10; the page up to 50). */
export const NOTIFICATIONS_MAX_LIMIT = 50;

export function notificationsRepo(db: Db, ws: string) {
  const mine = eq(s.notifications.workspaceId, ws);
  return {
    ...mutableScopedRepo(db, s.notifications, ws),
    /**
     * Inserts the draft unless its dedupe key exists in this workspace. The row when this call wrote it,
     * null otherwise (a re-run, a replayed event or a concurrent watcher adds none).
     */
    async insertOnce(draft: NotificationDraft, tx?: Executor): Promise<NotificationRow | null> {
      const rows = await (tx ?? db)
        .insert(s.notifications)
        .values({
          workspaceId: ws,
          kind: draft.kind,
          refType: draft.refType,
          refId: draft.refId,
          disputeId: draft.refType === "dispute" ? draft.refId : null,
          dedupeKey: dedupeKey(draft),
          data: draft.data,
        })
        .onConflictDoNothing({ target: [s.notifications.workspaceId, s.notifications.dedupeKey] })
        .returning();
      return rows[0] ?? null;
    },
    /** Newest first. */
    async latest(limit: number, tx?: Executor): Promise<NotificationRow[]> {
      return (tx ?? db)
        .select()
        .from(s.notifications)
        .where(mine)
        .orderBy(desc(s.notifications.createdAt), desc(s.notifications.id))
        .limit(Math.min(Math.max(limit, 1), NOTIFICATIONS_MAX_LIMIT));
    },
    async unreadCount(tx?: Executor): Promise<number> {
      const [row] = await (tx ?? db)
        .select({ n: count() })
        .from(s.notifications)
        .where(and(mine, isNull(s.notifications.readAt)));
      return row?.n ?? 0;
    },
    /** Marks the given ids (only this workspace's, only unread) read; the number changed. */
    async markRead(ids: readonly string[], at: Date, tx?: Executor): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await (tx ?? db)
        .update(s.notifications)
        .set({ readAt: at })
        .where(and(mine, isNull(s.notifications.readAt), inArray(s.notifications.id, [...ids])))
        .returning({ id: s.notifications.id });
      return rows.length;
    },
    async markAllRead(at: Date, tx?: Executor): Promise<number> {
      const rows = await (tx ?? db)
        .update(s.notifications)
        .set({ readAt: at })
        .where(and(mine, isNull(s.notifications.readAt)))
        .returning({ id: s.notifications.id });
      return rows.length;
    },
    /** The send job's result; `sent` also records `sent_via = 'email'` and `sent_at`. */
    async recordEmail(
      id: string,
      result: { status: EmailStatus; emailId?: string; at: Date },
      tx?: Executor,
    ): Promise<void> {
      const sent = result.status === "sent" ? { sentVia: "email", sentAt: result.at } : {};
      await (tx ?? db)
        .update(s.notifications)
        .set({ emailStatus: result.status, emailId: result.emailId ?? null, ...sent })
        .where(and(mine, eq(s.notifications.id, id)));
    },
  };
}
