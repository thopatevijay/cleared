"use client";
// The centre's data (M3-08): GET /api/notifications on SWR every 5 s (the bell count), and mark read
// (some ids, or all) through PATCH. A failed mark-read leaves the item unread and is reported per id.
import { useLocale } from "next-intl";
import { useCallback, useState } from "react";
import useSWR from "swr";
import { ApiError, getJson, newKey, patchJson } from "../../lib/api.ts";
import { NOTIFICATIONS_POLL_MS, type NotificationsData } from "../../lib/notifications-view.ts";

export function useNotifications(limit: number) {
  const locale = useLocale();
  const key = `/api/notifications?locale=${locale}&limit=${String(limit)}`;
  const { data, error, isLoading, mutate } = useSWR<NotificationsData, unknown>(
    key,
    (path: string) => getJson(path) as Promise<NotificationsData>,
    { refreshInterval: NOTIFICATIONS_POLL_MS, keepPreviousData: true },
  );
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());

  const patch = useCallback(
    async (body: { ids: string[] } | { all: true }, ids: readonly string[]): Promise<boolean> => {
      const res = await patchJson("/api/notifications", body, newKey());
      const ok = res.status === 200;
      setFailed((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (ok) next.delete(id);
          else next.add(id);
        }
        return next;
      });
      await mutate();
      return ok;
    },
    [mutate],
  );

  return {
    data,
    loading: isLoading && data === undefined,
    error: error !== undefined,
    reference: error instanceof ApiError ? error.correlationId : null,
    retry: () => void mutate(),
    failed,
    markRead: (id: string) => patch({ ids: [id] }, [id]),
    markAll: () => patch({ all: true }, data?.items.filter((i) => !i.read).map((i) => i.id) ?? []),
  };
}

export type NotificationsState = ReturnType<typeof useNotifications>;
