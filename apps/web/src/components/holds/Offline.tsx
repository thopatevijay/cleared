"use client";
// Offline (hold.md §States): the last data stays visible under a banner naming when it was loaded.
// SWR stops polling while the browser is offline and refetches on reconnect.
import { WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { formatClock } from "../../lib/format.ts";
import { useOnline } from "../../lib/use-online.ts";
import { useUiLocale } from "../disputes/text.ts";

/** When `data` last changed (ISO), or null before the first load. */
export function useLoadedAt(data: unknown): string | null {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (data !== undefined) setAt(new Date().toISOString());
  }, [data]);
  return at;
}

export function OfflineBanner({ loadedAt, timeZone }: { loadedAt: string | null; timeZone: string }) {
  const t = useTranslations("holds");
  const locale = useUiLocale();
  const online = useOnline();
  if (online || loadedAt === null) return null;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-border bg-status-info-bg p-3 text-status-info-fg"
      data-testid="offline-banner"
    >
      <span className="flex h-[1lh] shrink-0 items-center">
        <WifiOff aria-hidden="true" size={18} strokeWidth={1.75} />
      </span>
      {t("offline", { time: formatClock(locale, loadedAt, timeZone) })}
    </p>
  );
}
