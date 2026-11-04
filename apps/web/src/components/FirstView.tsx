"use client";
// The server-rendered first view of a data screen (M4-08): the bodies the page loaded through the API
// handlers (`server/first-view.ts`), keyed by API path, as SWR's fallback for the screen below. Each screen's
// `useSWR(path)` renders them on the first paint; polling and focus refreshes continue as before.
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

export function FirstView({
  fallback,
  children,
}: {
  fallback: Record<string, unknown>;
  children: ReactNode;
}) {
  return <SWRConfig value={{ fallback }}>{children}</SWRConfig>;
}
