"use client";
// The secondary path of the guided Completed step (M3-04, hold.md block D): a collapsed disclosure, always
// labelled "Effect on release unconfirmed", holding the `record_service_completed` ApprovalCard. "Review"
// creates the proposal on the server (POST /api/holds/:id/completed/record: the capture + COMPLETED), the
// card shows exactly what goes to PayPal with its fingerprint, and "Approve and record" → confirm approves
// that payload_sha256; the worker sends it. No state of this card changes the estimate or the timeline, and
// no copy says it releases money (PayPal support: an API equivalence is "not available").
import { PAYPAL_SUPPORT_QUOTES, type CompletedSummary, type HoldItem } from "@cleared/core";
import { ChevronDown, CircleCheck, CircleX, Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { getJson, loadSchemas, NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { fingerprint } from "../../lib/dispute-helpers.ts";
import type { ActionViewData } from "../../lib/dispute-view.ts";
import { useOnline } from "../../lib/use-online.ts";
import { Fingerprint } from "../disputes/DraftParts.tsx";
import { refusalOf } from "../disputes/text.ts";
import { ConfirmDialog } from "../tracking/TrackingCard.tsx";
import { SupportQuote, Toast, useFlash } from "./completed-parts.tsx";

const secondary =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-border-strong px-4 font-medium disabled:opacity-70 sm:w-auto";

const fetchAction = async (path: string): Promise<ActionViewData> =>
  (await loadSchemas()).ActionViewSchema.parse(((await getJson(path)) as { action: unknown }).action);

/** "Effect on release unconfirmed": held colours, icon + text (never colour alone). */
function UnconfirmedBadge() {
  const t = useTranslations("holds.completed.api");
  return (
    <span
      className="inline-flex min-h-6 items-center gap-1 rounded-pill bg-status-held-bg px-2 text-xs font-medium text-status-held-fg"
      data-testid="unconfirmed-badge"
    >
      <TriangleAlert aria-hidden="true" size={14} strokeWidth={1.75} />
      {t("badge")}
    </span>
  );
}

function Payload({ captureId }: { captureId: string }) {
  const t = useTranslations("holds.completed.api");
  const row = "flex flex-col gap-0.5 sm:flex-row sm:gap-3";
  const dt = "text-text-muted sm:w-48";
  return (
    <dl className="flex flex-col gap-2" data-testid="record-payload">
      <div className={row}>
        <dt className={dt}>{t("action")}</dt>
        <dd>
          <code lang="en" className="font-mono text-sm">
            {"record_service_completed"}
          </code>
        </dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t("fieldId")}</dt>
        <dd className="font-mono text-sm [overflow-wrap:anywhere]">{captureId}</dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t("fieldStatus")}</dt>
        <dd>
          <code lang="en" className="font-mono text-sm">
            {"COMPLETED"}
          </code>
        </dd>
      </div>
      <div className={row}>
        <dt className={dt}>{t("fieldTracking")}</dt>
        <dd>{t("noTracking")}</dd>
      </div>
    </dl>
  );
}

function Approve({ action, onApproved }: { action: ActionViewData; onApproved: () => void }) {
  const t = useTranslations("holds.completed.api");
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function send(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    const res = await postJson(
      `/api/actions/${action.id}/approve`,
      { payload_sha256: action.payload_sha256 },
      key.current,
    );
    setBusy(false);
    key.current = null;
    setOpen(false);
    if (res.status === 200) onApproved();
    else
      setError(
        res.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(res.body) ?? `HTTP_${String(res.status)}`),
      );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="record-review" data-action={action.id}>
      <Fingerprint sha={action.payload_sha256} previous={null} />
      {error === null ? null : (
        <p role="alert" className="text-status-error-fg" data-testid="record-error">
          {t("refused", { code: error })}
        </p>
      )}
      <button
        type="button"
        className={secondary}
        disabled={!online}
        onClick={() => {
          setOpen(true);
        }}
        data-testid="record-approve"
      >
        {t("approve")}
      </button>
      <ConfirmDialog
        open={open}
        busy={busy}
        testId="record"
        text={{
          title: t("dialogTitle"),
          body: t("dialogBody"),
          fingerprint: t("dialogFingerprint", { fp: fingerprint(action.payload_sha256) }),
          back: t("dialogCancel"),
          send: t("dialogConfirm"),
          sending: t("recording"),
        }}
        onClose={() => {
          setOpen(false);
        }}
        onSend={() => void send()}
      />
    </div>
  );
}

function Status({ record }: { record: CompletedSummary["record"] }) {
  const t = useTranslations("holds.completed.api");
  if (record.state === "recording")
    return (
      <p role="status" className="flex items-center gap-2" data-testid="record-recording">
        <Loader2 aria-hidden="true" size={16} className="spin" />
        {t("recording")}
      </p>
    );
  if (record.state === "recorded")
    return (
      <p className="flex items-start gap-2" data-testid="record-recorded">
        <CircleCheck
          aria-hidden="true"
          size={18}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-status-completed-fg"
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {record.readBack === "COMPLETED"
            ? t.rich("recorded", {
                debugId: record.debugId ?? "—",
                code: (chunks) => (
                  <code lang="en" className="font-mono text-sm">
                    {chunks}
                  </code>
                ),
              })
            : t("recordedNoRead", { debugId: record.debugId ?? "—" })}
        </span>
      </p>
    );
  if (record.state === "unknown")
    return (
      <p role="status" data-testid="record-unknown">
        {t("unknown")}
      </p>
    );
  if (record.state === "failed")
    return (
      <p role="alert" className="flex items-start gap-2 text-status-error-fg" data-testid="record-failed">
        <CircleX aria-hidden="true" size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t.rich("failed", {
            reason: record.refusal ?? "—",
            code: (chunks) => (
              <code lang="en" className="font-mono text-sm">
                {chunks}
              </code>
            ),
          })}
        </span>
      </p>
    );
  return null;
}

/** The toast "Recorded with PayPal" when the record lands while the page is open. */
function useRecordedToast(state: CompletedSummary["record"]["state"]): string | null {
  const t = useTranslations("holds.completed.api");
  const prev = useRef(state);
  const [toast, flash] = useFlash();
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (state === "recorded" && was !== "recorded") flash(t("recordedToast"));
  }, [state, flash, t]);
  return toast;
}

export function RecordCompletedCard({
  hold,
  record,
  onChanged,
}: {
  hold: HoldItem;
  record: CompletedSummary["record"];
  onChanged: () => void;
}) {
  const t = useTranslations("holds.completed.api");
  const online = useOnline();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<ActionViewData | null>(null);
  const key = useRef<string | null>(null);
  const { data: remote } = useSWR<ActionViewData, unknown>(
    record.state === "proposed" && record.actionId !== null ? `/api/actions/${record.actionId}` : null,
    fetchAction,
  );
  const toast = useRecordedToast(record.state);
  const proposal = local ?? (remote?.state === "proposed" ? remote : null);
  const canPropose = record.state === "none" || record.state === "failed";
  async function review(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    const res = await postJson(`/api/holds/${hold.id}/completed/record`, {}, key.current);
    setBusy(false);
    key.current = null;
    if (res.status === 201) {
      setError(null);
      setLocal((await loadSchemas()).ActionViewSchema.parse((res.body as { action: unknown }).action));
      onChanged();
    } else
      setError(
        res.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(res.body) ?? `HTTP_${String(res.status)}`),
      );
  }
  return (
    <div
      className="flex flex-col gap-3 border-t border-border pt-4"
      data-testid="record-completed"
      data-state={record.state}
    >
      {toast === null ? null : <Toast text={toast} testId="record-toast" />}
      <button
        type="button"
        className="inline-flex min-h-11 flex-wrap items-center gap-2 self-start text-left text-sm font-medium"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => {
          setOpen(!open);
        }}
        data-testid="record-toggle"
      >
        <ChevronDown
          aria-hidden="true"
          size={16}
          strokeWidth={1.75}
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        />
        <span>{t("toggle")}</span>
        <UnconfirmedBadge />
      </button>
      <div id={`${id}-panel`} hidden={!open} className="flex flex-col gap-3">
        <p className="text-sm">{t("noEstimate")}</p>
        <button
          type="button"
          className="inline-flex min-h-11 items-center self-start text-sm text-accent underline underline-offset-2"
          aria-expanded={why}
          onClick={() => {
            setWhy(!why);
          }}
        >
          {t("why")}
        </button>
        {why ? <SupportQuote quote={PAYPAL_SUPPORT_QUOTES.apiUnconfirmed.quote} /> : null}
        <section
          aria-labelledby={`${id}-card`}
          className="flex flex-col gap-3 rounded-lg border border-border p-4"
          data-testid="approval-card"
          data-kind="record_service_completed"
          data-state={record.state}
        >
          <h4 id={`${id}-card`} className="font-semibold">
            {t("heading")}
          </h4>
          <Payload captureId={hold.captureId} />
          <Status record={record} />
          {proposal !== null && record.state !== "recorded" ? (
            <Approve
              action={proposal}
              onApproved={() => {
                setLocal(null);
                onChanged();
              }}
            />
          ) : canPropose ? (
            <>
              {error === null ? null : (
                <p role="alert" className="text-status-error-fg" data-testid="record-error">
                  {t("refused", { code: error })}
                </p>
              )}
              <button
                type="button"
                className={secondary}
                disabled={busy || !online}
                aria-busy={busy || undefined}
                onClick={() => void review()}
                data-testid="record-review-button"
              >
                {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
                {t("review")}
              </button>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
