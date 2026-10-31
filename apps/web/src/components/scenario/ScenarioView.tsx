"use client";
// The judge scenario screen's live part (M2-10): SWR polls GET /api/scenarios/:id every 5 s while the tab
// is visible. States: loading (skeleton; a line after 3 s), error (ErrorPanel with the reference), success
// (outcome, timeline, sandbox decision), timed out and failed. The outcome sentence and "hold released"
// come only from PayPal's mirrored dispute and capture.
import { ScenarioViewSchema, type ScenarioView as View } from "@cleared/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { formatTime } from "../../lib/format.ts";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { SandboxDecision } from "./SandboxDecision.tsx";
import { ScenarioTimeline } from "./ScenarioTimeline.tsx";

export const SCENARIO_POLL_MS = 5_000;

async function fetchScenario(path: string): Promise<View> {
  return ScenarioViewSchema.parse(((await getJson(path)) as { scenario: unknown }).scenario);
}

function Loading() {
  const t = useTranslations("scenario");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => {
      setSlow(true);
    }, 3_000);
    return () => {
      clearTimeout(id);
    };
  }, []);
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-3">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} aria-hidden="true" className="skeleton-pulse block h-10 w-full rounded-md" />
      ))}
      <p role="status" className="text-text-muted">
        {slow ? t("loading") : ""}
      </p>
    </div>
  );
}

/** The outcome block: PayPal's resolution in honest words, then the hold as the capture reads now. */
export function ScenarioOutcome({ s }: { s: View }) {
  const t = useTranslations("scenario");
  if (s.outcome === null) return null;
  const sentence =
    s.outcome === "payout_paypal_covered"
      ? t("outcomePayout")
      : t("outcomeOther", { code: s.dispute?.outcome?.outcome_code ?? "" });
  return (
    <section
      aria-labelledby="outcome-heading"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      data-testid="scenario-outcome"
    >
      <h2 id="outcome-heading" className="sr-only">
        {t("step.outcome")}
      </h2>
      <StatusBadge status="info" detail={s.dispute?.status ?? null} />
      <p className="font-medium">{sentence}</p>
      {s.holdReleased ? (
        <p className="flex flex-wrap items-center gap-2">
          <StatusBadge status="completed" detail={s.capture?.status ?? null} />
          <span>{t("holdReleased")}</span>
        </p>
      ) : s.capture !== null ? (
        <p className="text-text-muted">
          {t("holdStill", {
            status:
              s.capture.reason === null ? s.capture.status : `${s.capture.status} / ${s.capture.reason}`,
          })}
        </p>
      ) : null}
    </section>
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
        {data.state === "timed_out" ? (
          <p role="status" className="rounded-md bg-status-info-bg p-3 text-status-info-fg">
            {t("timedOut")}
          </p>
        ) : null}
        {data.state === "failed" ? (
          <p role="status" className="rounded-md bg-status-error-bg p-3 text-status-error-fg">
            {t("failed")}
          </p>
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
      <div className="flex flex-col gap-4 xl:sticky xl:top-20 xl:col-span-5">
        <SandboxDecision
          scenarioId={data.id}
          decision={data.decision}
          onRequested={() => {
            void mutate();
          }}
        />
      </div>
    </div>
  );
}
