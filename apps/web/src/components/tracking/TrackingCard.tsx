"use client";
// The `add_tracking` ApprovalCard (M3-03; hold.md action slot, components.md ApprovalCard). The seller
// states carrier + tracking number (prefilled from the shipment evidence), "Review tracking" creates the
// proposal on the server (bound to the hold's order and capture), the card shows exactly what goes to
// PayPal with its fingerprint, and "Approve and file" → confirm approves that payload_sha256. Editing a
// field creates a new proposal and a new fingerprint. Nothing is sent from the browser to PayPal: the
// worker files it. Once filed, the card says so and the form is gone.
import type { HoldItem, TrackingSummary } from "@cleared/core";
import { CircleCheck, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import useSWR from "swr";
import { getJson, loadSchemas, NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { fingerprint } from "../../lib/dispute-helpers.ts";
import type { ActionViewData } from "../../lib/dispute-view.ts";
import { useOnline } from "../../lib/use-online.ts";
import { refusalOf } from "../disputes/text.ts";
import { Fingerprint } from "../disputes/DraftParts.tsx";
import { TierBadge } from "./RouteAdvice.tsx";

const OTHER = "OTHER";
const input = "min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 text-text";
const secondary =
  "inline-flex min-h-12 items-center justify-center rounded-md border border-border-strong px-4 font-medium";
const primary =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-on-accent disabled:opacity-70 sm:w-auto";

const fetchAction = async (path: string): Promise<ActionViewData> =>
  (await loadSchemas()).ActionViewSchema.parse(((await getJson(path)) as { action: unknown }).action);

interface Payload {
  readonly order_id: string;
  readonly capture_id: string;
  readonly carrier: string;
  readonly carrier_name_other?: string;
  readonly tracking_number: string;
}

/** The words of a hold action's confirm dialog (M3-04 reuses the dialog for `record_service_completed`). */
export interface ConfirmText {
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
  readonly back: string;
  readonly send: string;
  readonly sending: string;
}

function useTrackingConfirmText(sha: string): ConfirmText {
  const t = useTranslations("holds.tracking");
  return {
    title: t("confirmTitle"),
    body: t("confirmBody"),
    fingerprint: t("fingerprint", { fp: fingerprint(sha) }),
    back: t("back"),
    send: t("send"),
    sending: t("sending"),
  };
}

export function ConfirmDialog({
  open,
  text,
  onClose,
  onSend,
  busy,
  testId = "tracking",
}: {
  open: boolean;
  text: ConfirmText;
  onClose: () => void;
  onSend: () => void;
  busy: boolean;
  testId?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) {
      d.showModal();
      back.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[calc(100%-32px)] max-w-[480px] rounded-lg border border-border bg-surface p-5 text-text backdrop:bg-black/40"
      data-testid={`${testId}-confirm`}
    >
      <h2 id={`${id}-title`} className="mb-2 text-lg font-semibold">
        {text.title}
      </h2>
      <p id={`${id}-body`} className="mb-2">
        {text.body}
      </p>
      <p className="mb-4 text-sm text-text-muted">
        <code className="font-mono">{text.fingerprint}</code>
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button ref={back} type="button" onClick={onClose} className={secondary}>
          {text.back}
        </button>
        <button
          type="button"
          onClick={onSend}
          disabled={busy}
          aria-busy={busy || undefined}
          className={primary}
          data-testid={`${testId}-send`}
        >
          {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
          {busy ? text.sending : text.send}
        </button>
      </div>
    </dialog>
  );
}

/** The ApprovalCard's succeeded state: what was filed, and PayPal's debug_id as the proof it was taken. */
function Filed({ s, debugId }: { s: TrackingSummary; debugId: string | null }) {
  const t = useTranslations("holds.tracking");
  return (
    <div className="flex flex-col gap-1" data-testid="tracking-filed">
      <p className="flex items-center gap-2 font-semibold">
        <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} className="text-status-completed-fg" />
        {t("filed")}
      </p>
      {s.prefill === null || s.chosen === null ? null : (
        <p className="text-sm text-text-muted">
          {t("filedDetail", { carrier: s.chosen.name, number: s.prefill.tracking_number })}
        </p>
      )}
      {debugId === null ? null : (
        <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="tracking-debug-id">
          {t("filedAfterApproval")}
          <code lang="en" className="font-mono text-xs">
            {"debug_id"} {debugId}
          </code>
        </p>
      )}
    </div>
  );
}

/** hold.md "Tracking filing": a toast "Tracking filed" when filing completes while the page is open. */
function useFiledToast(state: TrackingSummary["state"] | null): boolean {
  const prev = useRef(state);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (state !== "filed" || was === "filed" || was === null) return;
    setShow(true);
    const timer = setTimeout(() => {
      setShow(false);
    }, 6000);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  return show;
}

function Review({
  action,
  s,
  onEdit,
  onApproved,
}: {
  action: ActionViewData;
  s: TrackingSummary;
  onEdit: () => void;
  onApproved: () => void;
}) {
  const t = useTranslations("holds.tracking");
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const p = action.payload as Payload;
  const confirmText = useTrackingConfirmText(action.payload_sha256);
  const tier = s.chosen?.code === p.carrier ? s.chosen.tier : null;
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
  // label above value below 640 px, so long PayPal ids keep one line (ui-reviewer M3-03 #5)
  const row = "flex flex-col gap-0.5 sm:flex-row sm:gap-3";
  return (
    <div className="flex flex-col gap-3" data-testid="tracking-review" data-action={action.id}>
      <h3 className="font-semibold">{t("reviewTitle")}</h3>
      <dl className="flex flex-col gap-2">
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("action")}</dt>
          <dd>
            <code lang="en" className="font-mono text-sm">
              {"add_tracking"}
            </code>
          </dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("carrier")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <span>
              {p.carrier === OTHER
                ? p.carrier_name_other
                : s.chosen?.code === p.carrier
                  ? s.chosen.name
                  : p.carrier}
            </span>
            <code lang="en" className="font-mono text-xs text-text-muted">
              {p.carrier}
            </code>
            {tier === null ? null : <TierBadge tier={tier} />}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("trackingNumber")}</dt>
          <dd className="font-mono break-all" data-testid="review-number">
            {p.tracking_number}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("order")}</dt>
          <dd className="font-mono text-xs">{p.order_id}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("capture")}</dt>
          <dd className="font-mono text-xs">{p.capture_id}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted sm:w-40">{t("notify")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {t("notifyNo")}
            <code lang="en" className="font-mono text-xs text-text-muted">
              {"notify_payer: false"}
            </code>
          </dd>
        </div>
      </dl>
      <div data-testid="tracking-fingerprint-block">
        <Fingerprint sha={action.payload_sha256} previous={null} />
      </div>
      {error === null ? null : (
        <p role="alert" className="text-status-error-fg" data-testid="tracking-error">
          {t("refused", { code: error })}
        </p>
      )}
      {online ? null : <p className="text-sm text-text-muted">{t("offline")}</p>}
      <div className="flex flex-col gap-2 md:flex-row">
        <button
          type="button"
          className={`${primary} md:w-auto`}
          disabled={!online}
          onClick={() => {
            setOpen(true);
          }}
          data-testid="tracking-approve"
        >
          {t("approve")}
        </button>
        <button type="button" className={secondary} onClick={onEdit} data-testid="tracking-edit">
          {t("edit")}
        </button>
      </div>
      <ConfirmDialog
        open={open}
        text={confirmText}
        busy={busy}
        onClose={() => {
          setOpen(false);
        }}
        onSend={() => void send()}
      />
    </div>
  );
}

function carrierOptions(s: TrackingSummary): { code: string; name: string }[] {
  const out = s.alternatives.map((a) => ({ code: a.code, name: a.name }));
  if (s.chosen !== null && s.chosen.code !== OTHER && !out.some((o) => o.code === s.chosen?.code)) {
    out.unshift({ code: s.chosen.code, name: s.chosen.name });
  }
  return out;
}

function Form({
  holdId,
  s,
  onProposed,
}: {
  holdId: string;
  s: TrackingSummary;
  onProposed: (a: ActionViewData) => void;
}) {
  const t = useTranslations("holds.tracking");
  const online = useOnline();
  const id = useId();
  const options = carrierOptions(s);
  const [carrier, setCarrier] = useState(s.prefill?.carrier ?? options[0]?.code ?? OTHER);
  const [other, setOther] = useState(s.prefill?.carrier_name_other ?? "");
  const [number, setNumber] = useState(s.prefill?.tracking_number ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function submit(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    const body = {
      carrier,
      tracking_number: number,
      ...(carrier === OTHER ? { carrier_name_other: other } : {}),
    };
    const res = await postJson(`/api/holds/${holdId}/tracking`, body, key.current);
    setBusy(false);
    key.current = null;
    if (res.status === 201) {
      setError(null);
      onProposed((await loadSchemas()).ActionViewSchema.parse((res.body as { action: unknown }).action));
    } else
      setError(
        res.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(res.body) ?? `HTTP_${String(res.status)}`),
      );
  }
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="tracking-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {s.prefill === null ? null : <p className="text-sm text-text-muted">{t("prefilled")}</p>}
      <label className="flex flex-col gap-1" htmlFor={`${id}-carrier`}>
        <span className="font-medium">{t("carrier")}</span>
        <select
          id={`${id}-carrier`}
          className={input}
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
          }}
          data-testid="carrier-select"
        >
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
              {" ("}
              {o.code}
              {")"}
            </option>
          ))}
          <option value={OTHER}>{t("carrierOtherOption")}</option>
        </select>
      </label>
      {carrier === OTHER ? (
        <label className="flex flex-col gap-1" htmlFor={`${id}-other`}>
          <span className="font-medium">{t("carrierName")}</span>
          <input
            id={`${id}-other`}
            className={input}
            value={other}
            maxLength={64}
            required
            onChange={(e) => {
              setOther(e.target.value);
            }}
          />
        </label>
      ) : null}
      <label className="flex flex-col gap-1" htmlFor={`${id}-number`}>
        <span className="font-medium">{t("trackingNumber")}</span>
        <input
          id={`${id}-number`}
          className={`${input} font-mono`}
          value={number}
          maxLength={64}
          required
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setNumber(e.target.value);
          }}
          data-testid="tracking-number"
        />
        <span id={`${id}-hint`} className="text-sm text-text-muted">
          {t("trackingHint")}
        </span>
      </label>
      {error === null ? null : (
        <p role="alert" className="text-status-error-fg" data-testid="tracking-error">
          {t("refused", { code: error })}
        </p>
      )}
      {online ? null : <p className="text-sm text-text-muted">{t("offline")}</p>}
      <button
        type="submit"
        className={primary}
        disabled={busy || !online}
        aria-busy={busy || undefined}
        data-testid="tracking-review-button"
      >
        {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
        {t("review")}
      </button>
    </form>
  );
}

export function TrackingCard({ hold, onChanged }: { hold: HoldItem; onChanged: () => void }) {
  const t = useTranslations("holds.tracking");
  const s = hold.tracking ?? null;
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState<ActionViewData | null>(null);
  const actionPath =
    s?.actionId != null && s.state !== "none" && s.state !== "filing"
      ? `/api/actions/${s.actionId}/${s.state}`
      : null;
  const { data: remote } = useSWR<ActionViewData, unknown>(actionPath, (k: string) =>
    fetchAction(k.slice(0, k.lastIndexOf("/"))),
  );
  const toast = useFiledToast(s?.state ?? null);
  if (s === null) return null;
  const action = local ?? (remote?.state === "proposed" ? remote : null);
  return (
    <>
      {toast ? (
        <p
          role="status"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm items-center gap-2 rounded-md bg-status-completed-bg p-3 font-medium text-status-completed-fg shadow-lg"
          data-testid="tracking-toast"
        >
          <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} />
          {t("filed")}
        </p>
      ) : null}
      <section
        id="tracking"
        tabIndex={-1}
        aria-labelledby="tracking-heading"
        className="flex scroll-mt-16 flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        data-testid="approval-card"
        data-kind="add_tracking"
        data-state={s.state}
      >
        <h3 id="tracking-heading" className="text-lg font-semibold">
          {t("cardTitle")}
        </h3>
        {s.state === "filed" ? (
          <Filed s={s} debugId={remote?.execution?.paypalDebugId ?? null} />
        ) : s.state === "filing" ? (
          <p role="status" className="flex items-center gap-2" data-testid="tracking-filing">
            <Loader2 aria-hidden="true" size={16} className="spin" />
            {t("filing")}
          </p>
        ) : (
          <>
            <p className="text-sm">{t("cardIntro")}</p>
            {s.state === "failed" && remote?.refusal != null ? (
              <p role="alert" className="text-status-error-fg">
                {t("failed", { code: remote.refusal })}
              </p>
            ) : null}
            {action !== null && !editing ? (
              <Review
                action={action}
                s={s}
                onEdit={() => {
                  setEditing(true);
                }}
                onApproved={() => {
                  setLocal(null);
                  onChanged();
                }}
              />
            ) : (
              <Form
                holdId={hold.id}
                s={s}
                onProposed={(a) => {
                  setLocal(a);
                  setEditing(false);
                  onChanged();
                }}
              />
            )}
          </>
        )}
      </section>
    </>
  );
}
