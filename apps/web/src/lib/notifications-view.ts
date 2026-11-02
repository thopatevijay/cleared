// The notification centre's API shapes (M3-08), shared by the route handler and the client components.
import type { NotificationKind } from "@cleared/core";

export interface NotificationItem {
  readonly id: string;
  readonly kind: NotificationKind;
  /** rendered server-side from the core templates in the requested locale (plain text) */
  readonly sentence: string;
  /** app path without the locale, e.g. `/disputes/<id>` */
  readonly href: string;
  readonly createdAt: string;
  readonly read: boolean;
  /** the workspace has an email and the send failed after retries */
  readonly emailNotSent: boolean;
}

export interface NotificationsData {
  readonly unread: number;
  readonly items: readonly NotificationItem[];
  readonly workspace: { readonly timezone: string };
}

export interface NotificationsPatched {
  readonly updated: number;
  readonly unread: number;
}

/** The panel shows the latest 10; the page up to 50 (`NOTIFICATIONS_MAX_LIMIT`). */
export const PANEL_LIMIT = 10;
export const PAGE_LIMIT = 50;
/** SWR poll of the bell count (notifications.md "Interactions"). */
export const NOTIFICATIONS_POLL_MS = 5_000;
