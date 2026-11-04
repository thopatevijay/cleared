"use client";
// The judge scenario screen's live part (M2-10): SWR polls GET /api/scenarios/:id every 5 s while the tab
// is visible. States: loading (skeleton; a line after 3 s), error (ErrorPanel with the reference), success
// (outcome, timeline, sandbox decision), timed out and failed. The outcome sentence and "hold released"
// come only from PayPal's mirrored dispute and capture.
import type { ScenarioView as View } from "@cleared/core";
import { TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { ApiError, getJson, loadSchemas } from "../../lib/api.ts";
import { formatTime } from "../../lib/format.ts";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { SandboxDecision } from "./SandboxDecision.tsx";
import { ScenarioEntry } from "./ScenarioEntry.tsx";
import { ScenarioOutcome } from "./ScenarioOutcome.tsx";
import { ScenarioTimeline } from "./ScenarioTimeline.tsx";

export const SCENARIO_POLL_MS = 5_000;

async function fetchScenario(path: string): Promise<View> {
  return (await loadSchemas()).ScenarioViewSchema.parse(
    ((await getJson(path)) as { scenario: unknown }).scenario,
  );
}

function Loading() {
  const t = useTranslations("scenario");
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const slow = setTimeout(() => {
      setElapsed(3);
    }, 3_000);
    const slower = setTimeout(() => {
      setElapsed(10);
    }, 10_000);
    return () => {
      clearTimeout(slow);
      clearTimeout(slower);
    };
  }, []);
  // timeline-shaped skeleton rows: an icon circle, a title line and a meta line
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} aria-hidden="true" className="flex gap-3">
          <span className="skeleton-pulse block h-6 w-6 shrink-0 rounded-full" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="skeleton-pulse block h-5 w-3/4 rounded-md" />
            <span className="skeleton-pulse block h-4 w-1/2 rounded-md" />
          </span>
        </div>
      ))}
      <p role="status" className="text-text-muted">
        {elapsed >= 10 ? t("stillWaiting") : elapsed >= 3 ? t("loading") : ""}
      </p>
    </div>
  );
}

export function ScenarioScreen({ id, timeZone }: { id: string; timeZone: string }) {
  const t = useTranslations("scenario");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  const { data, error, isValidating, mutate } = useSWR<View, unknown>(`/api/scenarios/${id}`, fetchScenario, {
    refreshInterval: (latest) =>
      latest !== undefined &&
      (latest.state === "resolved" || latest.state === "timed_out" || latest.state === "failed")
        ? 0
        : SCENARIO_POLL_MS,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
  if (data === undefined && error === undefined) return <Loading />;
  if (data === undefined) {
    return (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => {
          void mutate();
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6 xl:grid xl:grid-cols-12 xl:items-start xl:gap-8">
      <div className="flex flex-col gap-6 xl:col-span-7">
        <ScenarioOutcome s={data} />
        {data.state === "timed_out" || data.state === "failed" ? (
          <>
            <p
              role="status"
              className="flex items-start gap-2 rounded-md bg-status-error-bg p-3 text-status-error-fg"
            >
              <TriangleAlert aria-hidden="true" size={20} strokeWidth={1.75} className="mt-0.5 shrink-0" />
              <span>{data.state === "timed_out" ? t("timedOut") : t("failed")}</span>
            </p>
            <ScenarioEntry showOpen={false} />
          </>
        ) : null}
        <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
          <h2 id="timeline-heading" className="text-xl font-semibold">
            {t("timelineTitle")}
          </h2>
          <ScenarioTimeline steps={data.timeline} locale={locale} timeZone={timeZone} />
          {data.lastPolledAt !== null ? (
            <p className="text-sm text-text-muted">
              {t("lastChecked", { time: formatTime(locale, data.lastPolledAt, timeZone) })}
            </p>
          ) : null}
        </section>
      </div>
      <section
        aria-labelledby="sandbox-heading"
        className="flex flex-col gap-3 xl:sticky xl:top-20 xl:col-span-5"
        hidden={!data.decision.shown}
      >
        <h2 id="sandbox-heading" className="text-xl font-semibold">
          {t("sandboxHeading")}
        </h2>
        <SandboxDecision
          scenarioId={data.id}
          decision={data.decision}
          onRequested={() => {
            void mutate();
          }}
        />
      </section>
    </div>
  );
}
