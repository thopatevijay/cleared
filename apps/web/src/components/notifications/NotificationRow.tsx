"use client";
// One notification (notifications.md "Notification item"): icon + kind word, the sentence (plain text), the
// time, the link to its hold or dispute (≥ 64 px), and a separate 44 px "Mark as read" button. Unread items
// carry a 4 px accent rail AND the bold word "New" (never colour alone), and an "New:" accessible prefix.
import { AlarmClock, CalendarCheck, Check, Hourglass, Scale, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { NotificationKind } from "@cleared/core";
import { Link } from "../../i18n/navigation.ts";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { formatTime } from "../../lib/format.ts";
import type { NotificationItem } from "../../lib/notifications-view.ts";

const KIND: Readonly<Record<NotificationKind, { icon: LucideIcon; tone: string }>> = {
  hold_opened: { icon: Hourglass, tone: "bg-status-held-bg text-status-held-fg" },
  dispute_opened: { icon: Scale, tone: "bg-status-dispute-bg text-status-dispute-fg" },
  deadline_t72: { icon: AlarmClock, tone: "bg-status-held-bg text-status-held-fg" },
  deadline_t24: { icon: AlarmClock, tone: "bg-status-dispute-bg text-status-dispute-fg" },
  completed_reminder: { icon: CalendarCheck, tone: "bg-status-info-bg text-status-info-fg" },
};

export interface RowProps {
  readonly item: NotificationItem;
  readonly timeZone: string;
  readonly failed: boolean;
  readonly offline: boolean;
  readonly onMarkRead: (id: string) => void;
}

export function NotificationRow({ item, timeZone, failed, offline, onMarkRead }: RowProps) {
  const t = useTranslations("notifications");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const { icon: Icon, tone } = KIND[item.kind];
  const unread = !item.read;
  return (
    <li
      data-testid="notification"
      data-read={item.read ? "true" : "false"}
      className={`flex items-stretch gap-2 border-b border-border last:border-b-0 ${unread ? "border-l-4 border-l-accent" : "border-l-4 border-l-transparent"}`}
    >
      <Link
        href={item.href}
        onClick={() => {
          if (unread) onMarkRead(item.id);
        }}
        aria-label={unread ? `${t("newPrefix")} ${item.sentence}` : item.sentence}
        className="flex min-h-16 min-w-0 flex-1 flex-col gap-1 px-3 py-3 text-text hover:bg-surface-sunken"
      >
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <span className={`inline-flex h-6 items-center gap-1 rounded-pill px-2 font-medium ${tone}`}>
            <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
            {t(`kind.${item.kind}`)}
          </span>
          {unread ? <strong className="font-bold">{t("new")}</strong> : null}
        </span>
        <span className="break-words">{item.sentence}</span>
        <span className="text-sm text-text-muted">{formatTime(locale, item.createdAt, timeZone)}</span>
        {item.emailNotSent ? <span className="text-sm text-text-muted">{t("emailNotSent")}</span> : null}
      </Link>
      {unread ? (
        <div className="flex flex-col items-end justify-center gap-1 py-2 pr-2">
          <button
            type="button"
            disabled={offline}
            onClick={() => {
              onMarkRead(item.id);
            }}
            aria-label={t("markOne", { sentence: item.sentence })}
            title={offline ? t("offline") : undefined}
            className="inline-flex size-11 items-center justify-center rounded-md border border-border-strong text-text hover:bg-surface-sunken disabled:opacity-60"
          >
            <Check aria-hidden="true" size={20} strokeWidth={1.75} />
          </button>
          {failed ? (
            <span role="status" className="max-w-32 text-right text-sm text-status-error-fg">
              {t("markFailed")}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
