"use client";
// The /notifications page body (< 768 px the bell's target, and "See all"): up to 50 items, the same list
// and states as the panel.
import { useEffect } from "react";
import { PAGE_LIMIT } from "../../lib/notifications-view.ts";
import { NotificationList } from "./NotificationList.tsx";
import { useNotifications } from "./useNotifications.ts";

export function NotificationsPage() {
  const state = useNotifications(PAGE_LIMIT);
  // the bell's keyboard path below 768 px lands on the page heading (notifications.md "Interactions")
  useEffect(() => {
    document.getElementById("notifications-title")?.focus();
  }, []);
  return <NotificationList state={state} headingLevel={2} />;
}
