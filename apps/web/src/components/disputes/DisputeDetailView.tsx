"use client";
// Dispute detail (dispute-review.md "Detail"): PayPal facts, the draft reply (ApprovalCard), filing status,
// outcome, the judge scenario (M2-10) and the audit trail. SWR polls every 5 s while the dispute is open or a
// filing is in flight, and pauses while a confirm dialog is open. "#approval" (the dashboard's "Review and
// approve") moves focus to the ApprovalCard.
import { FileClock, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useRouter } from "../../i18n/navigation.ts";
import { ApiError, getParsed } from "../../lib/api.ts";
import type { DisputeDetail, Draft } from "../../lib/dispute-view.ts";
import { countdown, formatAmount } from "../../lib/format.ts";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { AuditTrail } from "./AuditTrail.tsx";
import { DisputeScenario } from "./DisputeScenario.tsx";
import { EvidenceItems } from "./DraftParts.tsx";
import { DraftReview } from "./DraftReview.tsx";
import { FilingStatus } from "./FilingStatus.tsx";
import { Outcome } from "./Outcome.tsx";
import { PaypalFacts } from "./PaypalFacts.tsx";
import { useUiLocale } from "./text.ts";
import { useRevise } from "./useRevise.ts";

export const DETAIL_POLL_MS = 5_000;
const IN_FLIGHT = new Set(["approved", "executing", "unknown"]);

async function fetchDetail(path: string): Promise<DisputeDetail> {
  return getParsed(path, (s) => s.DisputeDetailSchema);
}

function NoDraft({ d }: { d: DisputeDetail }) {
  const t = useTranslations("disputes.draft");
  if (d.dispute.deadlineState === "closed_for_action")
    return <p className="text-text-muted">{t("tooLate")}</p>;
  if (d.draftOutcome === null) {
    return (
      <p role="status" className="flex items-center gap-2 text-text-muted" data-testid="drafting">
        <Loader2 aria-hidden="true" size={16} className="spin" />
        {t("drafting")}
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      data-testid="draft-unavailable"
    >
      <p className="flex items-center gap-2 font-medium">
        <FileClock aria-hidden="true" size={20} />
        {d.draftOutcome.kind === "too_late" ? t("tooLate") : t("unavailable")}
      </p>
      {d.draftOutcome.code === null ? null : (
        <p className="text-sm">
          {t.has(`unavailableWhy.${d.draftOutcome.code}`)
            ? t(`unavailableWhy.${d.draftOutcome.code}`)
            : t("unavailableWhy.other")}{" "}
          <span className="font-mono text-xs text-text-muted">
            {t("unavailableCode", { code: d.draftOutcome.code })}
          </span>
        </p>
      )}
      <a
        href="https://www.sandbox.paypal.com/resolutioncenter"
        className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
      >
        {t("resolutionCenter")}
      </a>
      {d.packItems.length === 0 ? null : (
        <EvidenceItems
          items={d.packItems}
          selected={new Set()}
          readOnly
          timeZone={d.workspace.timezone}
          onToggle={() => undefined}
          mode="download"
        />
      )}
    </div>
  );
}

function DueBand({ d, now }: { d: DisputeDetail["dispute"]; now: number }) {
  const t = useTranslations("disputes");
  if (d.dueDate === null || d.status === "RESOLVED") return null;
  const c = countdown(now, d.dueDate);
  const label =
    d.deadlineState === "closed_for_action"
      ? t("deadline.closed")
      : t(c.unit === "hours" ? "band.hours" : "band.days", { n: c.n });
  return (
    <p
      className="sticky top-14 z-10 -mx-4 border-b border-border bg-bg px-4 py-2 text-sm font-medium xl:static xl:mx-0 xl:border-0 xl:p-0"
      data-testid="due-band"
      data-sticky-band
    >
      {label}
    </p>
  );
}

function usePolledDetail(id: string, paused: boolean) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  return useSWR<DisputeDetail, unknown>(`/api/disputes/${id}`, fetchDetail, {
    refreshInterval: (d) =>
      d === undefined || d.dispute.status !== "RESOLVED" || IN_FLIGHT.has(d.draft?.action?.state ?? "")
        ? DETAIL_POLL_MS
        : 0,
    isPaused: () => pausedRef.current,
    refreshWhenHidden: false,
    keepPreviousData: true,
  });
}

export function DisputeDetailView({ id }: { id: string }) {
  const t = useTranslations("disputes");
  const locale = useUiLocale();
  const router = useRouter();
  const [dialog, setDialog] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { data, error, isValidating, mutate } = usePolledDetail(id, dialog);
  const focused = useRef(false);
  const draftId = data?.draft?.id ?? null;
  const repropose = useRevise(data?.dispute.id ?? id, draftId, () => mutate());
  useEffect(() => {
    const i = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      clearInterval(i);
    };
  }, []);
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  useEffect(() => {
    if (data === undefined || focused.current || window.location.hash !== "#approval") return;
    focused.current = true;
    document.getElementById("approval")?.focus();
  }, [data]);

  if (data === undefined && error === undefined) {
    return (
      <div aria-busy="true" data-testid="loading" className="flex flex-col gap-4">
        <span aria-hidden="true" className="skeleton-pulse block h-40 rounded-lg" />
        <span aria-hidden="true" className="skeleton-pulse block h-80 rounded-lg" />
        <p role="status" className="text-text-muted">
          {t("loadingOne")}
        </p>
      </div>
    );
  }
  if (data === undefined) {
    return (
      <ErrorPanel
        title={t("errorOneTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  }
  const d = data.dispute;
  const amount = d.amount ?? d.payment?.amount ?? null;
  const a = amount === null ? null : formatAmount(locale, amount);
  const action = data.draft?.action ?? null;
  const draft = data.draft;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">
        <span className="tabular">
          {t("h1", { amount: a === null ? d.disputeId : `${a.text} ${a.code}` })}
        </span>
      </h1>
      <DueBand d={d} now={now} />
      <div className="flex flex-col gap-6 xl:grid xl:grid-cols-12 xl:items-start xl:gap-8">
        <div className="flex flex-col gap-6 xl:col-span-7">
          <PaypalFacts d={d} timeZone={data.workspace.timezone} />
          {draft === null ? (
            <NoDraft d={data} />
          ) : (
            <DraftReview detail={{ ...data, draft }} onChanged={() => mutate()} onDialog={setDialog} />
          )}
        </div>
        <div className="flex flex-col gap-6 xl:sticky xl:top-20 xl:col-span-5">
          <section aria-labelledby="status-heading" className="flex flex-col gap-3">
            <h2 id="status-heading" className="text-xl font-semibold">
              {t("status.heading")}
            </h2>
            <FilingStatus
              action={action}
              timeZone={data.workspace.timezone}
              canRepropose={reproposable(data, draft)}
              reproposing={repropose.busy}
              onRepropose={() => {
                if (draft !== null)
                  void repropose.revise({
                    notes: draft.notes,
                    itemIds: draft.items.filter((i) => i.selected).map((i) => i.id),
                  });
              }}
            />
          </section>
          <Outcome d={d} />
          {data.scenarioId === null ? null : (
            <DisputeScenario scenarioId={data.scenarioId} timeZone={data.workspace.timezone} />
          )}
          <AuditTrail entries={data.audit} timeZone={data.workspace.timezone} />
        </div>
      </div>
    </div>
  );
}

/** A failed filing can be proposed again from the same draft while PayPal still allows it in time. */
function reproposable(d: DisputeDetail, draft: Draft | null): boolean {
  return (
    draft !== null &&
    draft.action?.state === "failed" &&
    draft.allowed &&
    d.dispute.deadlineState !== "closed_for_action" &&
    d.dispute.status !== "RESOLVED"
  );
}
