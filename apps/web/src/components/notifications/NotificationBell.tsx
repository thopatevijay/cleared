"use client";
// The header bell (M3-08, notifications.md): a 44 × 44 button whose accessible name carries the unread
// count ("Notifications, 2 unread"), with a count pill ("9+" above 9). Below 768 px it opens the
// /notifications page; from 768 px a non-modal panel (380 px, max 70vh) with the latest 10, "Mark all as
// read" and "See all". Escape or a click outside closes it and returns focus to the bell. When the count
// rises between polls, one polite announcement names the newest item.
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useRouter } from "../../i18n/navigation.ts";
import { PANEL_LIMIT } from "../../lib/notifications-view.ts";
import { NotificationList } from "./NotificationList.tsx";
import { useNotifications, type NotificationsState } from "./useNotifications.ts";

const PANEL_MIN_WIDTH = 768;

/** One polite line per rise in the unread count, naming the newest unread item. */
function useAnnouncement(state: NotificationsState): string {
  const t = useTranslations("notifications");
  const prev = useRef<number | null>(null);
  const [text, setText] = useState("");
  const unread = state.data?.unread;
  useEffect(() => {
    if (unread === undefined) return;
    const before = prev.current;
    prev.current = unread;
    if (before === null || unread <= before) return;
    const newest = state.data?.items.find((i) => !i.read);
    if (newest) setText(t("announce", { count: unread - before, sentence: newest.sentence }));
  }, [unread, state.data, t]);
  return text;
}

/** Escape and outside clicks close the panel; focus goes back to the bell. */
function useDismiss(open: boolean, close: () => void, root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, root]);
}

export function NotificationBell() {
  const t = useTranslations("notifications");
  const router = useRouter();
  const state = useNotifications(PANEL_LIMIT);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const announcement = useAnnouncement(state);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useDismiss(open, close, root);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  const unread = state.data?.unread ?? 0;
  return (
    <div ref={root} className="relative">
      <BellButton
        ref={button}
        unread={state.data === undefined ? null : unread}
        expanded={open}
        onClick={() => {
          if (window.innerWidth < PANEL_MIN_WIDTH) router.push("/notifications");
          else setOpen((o) => !o);
        }}
      />
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      {open ? (
        <div
          role="dialog"
          aria-labelledby={headingId}
          className="absolute top-full right-0 z-[var(--z-dialog)] mt-2 flex max-md:hidden max-h-[70vh] w-[380px] max-w-[calc(100vw-32px)] flex-col gap-3 overflow-y-auto rounded-lg bg-surface p-4 shadow-[var(--shadow-overlay)]"
        >
          <h2 id={headingId} ref={heading} tabIndex={-1} className="text-lg font-semibold">
            {t("title")}
          </h2>
          <NotificationList state={state} headingLevel={3} />
          <Link
            href="/notifications"
            className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
          >
            {t("seeAll")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function BellButton({
  ref,
  unread,
  expanded,
  onClick,
}: {
  ref: React.RefObject<HTMLButtonElement | null>;
  unread: number | null;
  expanded: boolean;
  onClick: () => void;
}) {
  const t = useTranslations("notifications");
  const count = unread ?? 0;
  return (
    <button
      ref={ref}
      type="button"
      data-testid="notification-bell"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={count > 0 ? t("bell", { count }) : t("bellNone")}
      onClick={onClick}
      className="relative inline-flex size-11 items-center justify-center rounded-md text-text hover:bg-surface-sunken"
    >
      <Bell aria-hidden="true" size={22} strokeWidth={1.75} />
      {count > 0 ? (
        <span
          aria-hidden="true"
          data-testid="notification-count"
          className="absolute -top-0.5 -right-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-status-dispute-bg px-1 text-xs font-bold text-status-dispute-fg ring-1 ring-status-dispute-fg"
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}
