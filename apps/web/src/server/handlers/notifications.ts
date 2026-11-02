// GET / PATCH /api/notifications (M3-08, notifications.md): the session's workspace's notifications, the
// unread count, and mark read (some ids, or all). Workspace-scoped: ids from another workspace never match.
// Sentences are rendered here from the core templates (the same copy as the emails), as plain text.
import {
  fromEpochMs,
  LOCALES,
  notificationPath,
  renderNotification,
  storedNotification,
  type Locale,
  WorkspaceIdSchema,
} from "@cleared/core";
import { forWorkspace, NOTIFICATIONS_MAX_LIMIT, platform, type NotificationRow } from "@cleared/db";
import { z } from "zod";
import type {
  NotificationItem,
  NotificationsData,
  NotificationsPatched,
} from "../../lib/notifications-view.ts";
import { dayKey } from "../../lib/format.ts";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";

const QuerySchema = z.object({
  locale: z.enum(LOCALES).default("en"),
  limit: z.coerce.number().int().min(1).max(NOTIFICATIONS_MAX_LIMIT).default(10),
});

const PatchSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(NOTIFICATIONS_MAX_LIMIT) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

function item(row: NotificationRow, locale: Locale, timeZone: string, now: Date): NotificationItem | null {
  const input = storedNotification(row);
  if (input === null) return null;
  const rendered = renderNotification(input, {
    locale,
    timeZone,
    appBaseUrl: "",
    now: fromEpochMs(now.getTime()),
  });
  return {
    id: row.id,
    kind: input.kind,
    sentence: rendered.sentence,
    href: notificationPath(input),
    createdAt: row.createdAt.toISOString(),
    read: row.readAt !== null,
    emailNotSent: row.emailStatus === "failed",
  };
}

/** Newest day first; within a day, unread first, then newest (notifications.md "Success"). */
function ordered(items: NotificationItem[], timeZone: string): NotificationItem[] {
  const key = (i: NotificationItem) => dayKey(i.createdAt, timeZone);
  return items.sort(
    (a, b) =>
      key(b).localeCompare(key(a)) ||
      Number(a.read) - Number(b.read) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getNotifications(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const p = new URL(req.url).searchParams;
  const q = QuerySchema.safeParse({
    locale: p.get("locale") ?? undefined,
    limit: p.get("limit") ?? undefined,
  });
  if (!q.success) return apiError(400, "invalid_request", "Unknown locale or limit.", correlationId(req));
  const repo = forWorkspace(deps.db, WorkspaceIdSchema.parse(session.workspaceId)).notifications;
  const ws = await platform(deps.db).workspaces.get(session.workspaceId);
  const timeZone = ws?.timezone ?? "UTC";
  const now = deps.now();
  const [rows, unread] = await Promise.all([repo.latest(q.data.limit), repo.unreadCount()]);
  const items = rows.flatMap((r) => item(r, q.data.locale, timeZone, now) ?? []);
  const body: NotificationsData = {
    unread,
    items: ordered(items, timeZone),
    workspace: { timezone: timeZone },
  };
  return withRenewal(json(body), session);
}

export async function patchNotifications(req: Request, deps: Deps): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const parsed = PatchSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return apiError(400, "invalid_request", "Send { ids: [...] } or { all: true }.", correlationId(req));
  }
  const repo = forWorkspace(deps.db, WorkspaceIdSchema.parse(session.workspaceId)).notifications;
  const at = deps.now();
  const updated =
    "all" in parsed.data ? await repo.markAllRead(at) : await repo.markRead(parsed.data.ids, at);
  const body: NotificationsPatched = { updated, unread: await repo.unreadCount() };
  return withRenewal(json(body), session);
}
