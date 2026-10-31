"use client";
// The judge scenario on the dispute page (dispute-review.md §5, M2-10's components): the timeline of real
// sandbox steps and "Simulate PayPal's decision (sandbox only)", for the scenario run on this dispute. It
// sits in the right column, separated from Approve by the filing status, never adjacent to it.
import { ScenarioViewSchema, type ScenarioView } from "@cleared/core";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { Link } from "../../i18n/navigation.ts";
import { getJson } from "../../lib/api.ts";
import { SandboxDecision } from "../scenario/SandboxDecision.tsx";
import { ScenarioTimeline } from "../scenario/ScenarioTimeline.tsx";
import { useUiLocale } from "./text.ts";

async function fetchScenario(path: string): Promise<ScenarioView> {
  return ScenarioViewSchema.parse(((await getJson(path)) as { scenario: unknown }).scenario);
}

export function DisputeScenario({ scenarioId, timeZone }: { scenarioId: string; timeZone: string }) {
  const t = useTranslations("disputes.scenario");
  const locale = useUiLocale();
  const { data, mutate } = useSWR<ScenarioView, unknown>(`/api/scenarios/${scenarioId}`, fetchScenario, {
    refreshInterval: (s) => (s === undefined || s.finishedAt === null ? 5_000 : 0),
    refreshWhenHidden: false,
  });
  if (data === undefined) return null;
  return (
    <section
      aria-labelledby="scenario-heading"
      className="flex flex-col gap-3"
      data-testid="dispute-scenario"
    >
      <h2 id="scenario-heading" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <ScenarioTimeline steps={data.timeline} locale={locale} timeZone={timeZone} />
      <SandboxDecision scenarioId={data.id} decision={data.decision} onRequested={() => void mutate()} />
      <Link
        href={`/scenario/${data.id}`}
        className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
      >
        {t("open")}
      </Link>
    </section>
  );
}
