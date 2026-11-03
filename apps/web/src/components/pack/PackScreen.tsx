"use client";
// The payment detail and proof pack (payment-detail.md), M2-05. The server renders the first view; SWR
// then polls GET /api/packs/:packId every 5 s while the agent may still change it (collecting, checking,
// stale) and stops once settled. A new check is announced once ("Verdicts updated: …"). 375/768: one
// column, verdicts before evidence; 1440: 8/12 left (header, banner, verdicts, facts) and 4/12 sticky right
// (intake and evidence). All model output and evidence render as plain text.
import {
  packViewSettled,
  PackViewSchema,
  type PackView,
  type PackViewState,
  type Verdict,
} from "@cleared/core";
import { FilePlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useRouter } from "../../i18n/navigation.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { useOnline } from "../../lib/use-online.ts";
import { AckLinkPanel } from "./AckLink.tsx";
import { PackLoading } from "./PackLoading.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { EvidenceIntake } from "./EvidenceIntake.tsx";
import { EvidenceList } from "./EvidenceList.tsx";
import { FactsList } from "./FactsList.tsx";
import { PackStateBanner } from "./PackStateBanner.tsx";
import { PaymentHeader } from "./PaymentHeader.tsx";
import { ScopeSnapshotPanel } from "./ScopeSnapshotButton.tsx";
import { VerdictRow } from "./VerdictRow.tsx";

export const PACK_POLL_MS = 5_000;
const UNAVAILABLE: readonly PackViewState[] = ["check_unavailable", "budget_exceeded"];

async function fetchPack(path: string): Promise<PackView> {
  return PackViewSchema.parse(await getJson(path));
}

function countsOf(view: PackView): Record<Verdict, number> {
  const c: Record<Verdict, number> = { met: 0, partial: 0, missing: 0, unverifiable: 0 };
  for (const v of view.check?.verdicts ?? []) c[v.verdict] += 1;
  return c;
}

/** "Verdicts updated: …" once per new check version (never on the first render or unchanged polls). */
function useVerdictAnnouncement(view: PackView): string {
  const t = useTranslations("pack");
  const seen = useRef(view.check?.version ?? 0);
  const [text, setText] = useState("");
  const version = view.check?.version ?? 0;
  useEffect(() => {
    if (version === seen.current || version === 0) return;
    seen.current = version;
    setText(t("verdictsUpdated", countsOf(view)));
  }, [version, view, t]);
  return text;
}

function Verdicts({ view, kindOf }: { view: PackView; kindOf: (id: string) => string }) {
  const t = useTranslations("pack");
  if (UNAVAILABLE.includes(view.pack.view)) {
    return (
      <p data-testid="no-verdict">
        <span aria-hidden="true">{"—"}</span> <span className="text-text-muted">{t("noVerdict")}</span>
      </p>
    );
  }
  if (view.check === null) return <p className="text-text-muted">{t("noVerdicts")}</p>;
  const previous = view.check.previous;
  return (
    <div className="flex flex-col gap-2">
      {previous ? <p className="text-sm font-medium text-text-muted">{t("previous")}</p> : null}
      <ul className="flex flex-col" data-testid="verdicts" data-previous={previous}>
        {view.check.verdicts.map((v) => (
          <VerdictRow key={v.lineId} v={v} kindOf={kindOf} previous={previous} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Loads the pack client-side (the page has already checked it is this workspace's): loading skeleton,
 * full-page error with Retry and Reference, then the pack, polled while the agent works.
 */
export function PackScreen({ packId, focusIntake }: { packId: string; focusIntake: boolean }) {
  const t = useTranslations("pack");
  const router = useRouter();
  const online = useOnline();
  const { data, error, isValidating, mutate } = useSWR<PackView, unknown>(`/api/packs/${packId}`, fetchPack, {
    refreshInterval: (d) => (d === undefined || !packViewSettled(d.pack.view) ? PACK_POLL_MS : 0),
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    keepPreviousData: true,
  });
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  if (data === undefined && error === undefined) return <PackLoading />;
  if (data === undefined) {
    return (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  }
  // offline: the last data stays; polling pauses and the intake says why it is disabled
  const refreshFailed = online && error !== undefined && !(error instanceof ApiError && error.status === 401);
  return (
    <PackBody
      view={data}
      focusIntake={focusIntake}
      refreshError={refreshFailed ? error : undefined}
      reload={() => void mutate()}
    />
  );
}

function PackBody({
  view,
  focusIntake,
  refreshError,
  reload,
}: {
  view: PackView;
  focusIntake: boolean;
  refreshError: unknown;
  reload: () => void;
}) {
  const t = useTranslations("pack");
  const announcement = useVerdictAnnouncement(view);
  const kinds = useMemo(() => new Map(view.evidence.map((e) => [e.id, t(`kind.${e.kind}`)])), [view, t]);
  const kindOf = (id: string): string => kinds.get(id) ?? t("kind.delivery");
  const tz = view.workspace.timezone;
  const intake = <EvidenceIntake packId={view.pack.id} focusOnMount={focusIntake} onAdded={reload} />;
  return (
    <div className="flex flex-col gap-6 xl:grid xl:grid-cols-12 xl:items-start xl:gap-8">
      <div className="flex flex-col gap-6 xl:col-span-8">
        <PaymentHeader payment={view.payment} timeZone={tz} />
        {refreshError !== undefined ? (
          <ErrorPanel
            title={t("refreshError")}
            reference={refreshError instanceof ApiError ? refreshError.correlationId : null}
            onRetry={reload}
          />
        ) : null}
        <PackStateBanner
          view={view.pack.view}
          checkedAt={view.pack.checkedAt}
          counts={countsOf(view)}
          timeZone={tz}
        />
        {view.pack.view === "empty" ? (
          <EmptyState icon={FilePlus} title={t("empty.title")} body={t("empty.body")}>
            <a
              href="#intake"
              className="inline-flex min-h-12 items-center rounded-md border border-border-strong px-4 font-medium"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("intake-heading")?.focus();
                document.getElementById("intake-open")?.click();
              }}
            >
              {t("intake.open")}
            </a>
          </EmptyState>
        ) : null}
        <section aria-labelledby="proof-check" className="flex flex-col gap-3">
          <h2 id="proof-check" className="text-xl font-semibold">
            {t("proofCheck")}
          </h2>
          <Verdicts view={view} kindOf={kindOf} />
        </section>
        <section aria-labelledby="facts-heading" className="flex flex-col gap-3">
          <h2 id="facts-heading" className="text-xl font-semibold">
            {t("facts")}
          </h2>
          <FactsList facts={view.facts} kindOf={kindOf} />
        </section>
        <AckLinkPanel packId={view.pack.id} timeZone={tz} onAccepted={reload} />
        <ScopeSnapshotPanel
          packId={view.pack.id}
          hasScope={view.evidence.some((i) => i.kind === "scope")}
          snapshots={view.evidence.filter((i) => i.kind === "scope_snapshot").length}
          onQueued={reload}
        />
      </div>
      <section
        aria-labelledby="evidence-heading"
        className="flex flex-col gap-4 xl:sticky xl:top-20 xl:col-span-4"
      >
        <h2 id="evidence-heading" className="text-xl font-semibold">
          {t("evidence")}
        </h2>
        {intake}
        <EvidenceList items={view.evidence} timeZone={tz} />
      </section>
      <p aria-live="polite" className="sr-only" data-testid="pack-live">
        {announcement}
      </p>
    </div>
  );
}
