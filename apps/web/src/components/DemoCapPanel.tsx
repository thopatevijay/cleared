"use client";
// The demo cap's panel (landing.md "Cap reached" / "Per-network cap", BL-01 6649565560): the global cap
// says how many minutes; the per-network cap states the rolling 24 h limit, when the next slot frees (in
// the viewer's own time zone) and points to the README's judging guide. Never "tomorrow".
import { Hourglass } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DemoCap } from "../lib/demo-cap.ts";
import { formatSlotTime } from "../lib/format.ts";
import { JUDGE_GUIDE_URL } from "../lib/site.ts";

function PerIpText({ cap }: { cap: DemoCap }) {
  const t = useTranslations("landing");
  const locale = useLocale();
  const guide = (chunks: ReactNode) => (
    <a
      href={JUDGE_GUIDE_URL}
      lang={locale === "en" ? undefined : "en"}
      className="font-semibold underline underline-offset-2"
    >
      {chunks}
    </a>
  );
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const at = (chunks: ReactNode) => <time dateTime={cap.retryAt ?? undefined}>{chunks}</time>;
  return (
    <>
      {t("capIp", { limit: cap.limit })}{" "}
      {cap.retryAt === null
        ? t("capIpNoTime")
        : t.rich("capIpNext", { at, time: formatSlotTime(`${locale}-IN`, cap.retryAt, zone, Date.now()) })}{" "}
      {t.rich("capIpGuide", { guide })}
    </>
  );
}

export function DemoCapPanel({ cap }: { cap: DemoCap }) {
  const t = useTranslations("landing");
  const tc = useTranslations("common");
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md bg-status-held-bg p-4 text-status-held-fg"
      data-testid="demo-cap"
    >
      <p className="flex items-start gap-2 font-medium">
        <Hourglass aria-hidden="true" size={20} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>{cap.perIp ? <PerIpText cap={cap} /> : t("capBusy", { minutes: cap.minutes })}</span>
      </p>
      {cap.ref ? (
        <p className="text-sm">
          {tc("reference")}
          {": "}
          <code className="font-mono text-xs break-all">{cap.ref}</code>
        </p>
      ) : null}
    </div>
  );
}
