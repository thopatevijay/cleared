"use client";
// The centre's body, shared by the panel (≥ 768 px, latest 10) and the /notifications page (up to 50):
// "Mark all as read", then loading (3 skeleton items) / error (ErrorPanel, Retry, Reference) / empty /
// the items. A polite status line confirms "All notifications marked as read".
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useOnline } from "../../lib/use-online.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { NotificationRow } from "./NotificationRow.tsx";
import type { NotificationsState } from "./useNotifications.ts";

function Skeleton({ label }: { label: string }) {
  return (
    <ul
      aria-busy="true"
      aria-label={label}
      className="flex flex-col gap-2"
      data-testid="notifications-loading"
    >
      {[0, 1, 2].map((i) => (
        <li key={i} className="h-16 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none">
          {i === 0 ? <span className="sr-only">{label}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function NotificationList({
  state,
  headingLevel,
}: {
  state: NotificationsState;
  headingLevel: 2 | 3;
}) {
  const t = useTranslations("notifications");
  const online = useOnline();
  const [confirmed, setConfirmed] = useState(false);
  const { data } = state;
  const unread = data?.unread ?? 0;
  if (state.error && data === undefined) {
    return <ErrorPanel title={t("loadError")} reference={state.reference} onRetry={state.retry} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <div
        className={`flex flex-wrap items-center gap-3 ${data === undefined || data.items.length === 0 ? "hidden" : ""}`}
      >
        <button
          type="button"
          disabled={!online || unread === 0}
          onClick={() => {
            setConfirmed(false);
            void state.markAll().then(setConfirmed);
          }}
          className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 font-medium text-text hover:bg-surface-sunken disabled:opacity-60"
        >
          {t("markAll")}
        </button>
        {!online ? <span className="text-sm text-text-muted">{t("offline")}</span> : null}
        <span role="status" className="text-sm text-text-muted">
          {confirmed ? t("allMarked") : ""}
        </span>
      </div>
      {state.error && online ? (
        <ErrorPanel title={t("loadError")} reference={state.reference} onRetry={state.retry} />
      ) : null}
      {state.loading ? <Skeleton label={t("loading")} /> : null}
      {data !== undefined && data.items.length === 0 ? (
        <EmptyState icon={Bell} title={t("emptyTitle")} body={t("empty")} headingLevel={headingLevel} />
      ) : null}
      {data !== undefined && data.items.length > 0 ? (
        <ul className="flex flex-col rounded-md border border-border bg-surface" aria-label={t("title")}>
          {data.items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              timeZone={data.workspace.timezone}
              failed={state.failed.has(item.id)}
              offline={!online}
              onMarkRead={(id) => void state.markRead(id)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
