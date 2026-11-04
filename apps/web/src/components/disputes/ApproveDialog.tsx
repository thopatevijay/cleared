"use client";
// Approve → confirm (dispute-review.md, components.md ApprovalCard 7): an alertdialog that states what goes
// to PayPal and that it can't be withdrawn; initial focus "Go back"; Escape cancels and focus returns to
// Approve. "Send to PayPal" re-reads the dispute's current proposal and approves it with the fingerprint the
// seller reviewed: a draft that changed meanwhile (another tab's edit) is refused APPROVAL_HASH_MISMATCH by
// M2-08, never approved blind. Nothing is sent from the browser to PayPal; the worker files it.
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { getParsed, NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { fingerprint } from "../../lib/dispute-helpers.ts";
import { refusalOf } from "./text.ts";

/** The action to approve now: the dispute's current proposal, else the one the seller reviewed. */
async function currentActionId(disputeId: string, reviewed: string): Promise<string> {
  try {
    const d = await getParsed(`/api/disputes/${disputeId}`, (s) => s.DisputeDetailSchema);
    return d.draft?.action?.state === "proposed" ? d.draft.action.id : reviewed;
  } catch {
    return reviewed;
  }
}

export function ApproveDialog({
  open,
  disputeId,
  actionId,
  reviewedSha,
  onClose,
  onApproved,
  onRefused,
}: {
  open: boolean;
  disputeId: string;
  actionId: string;
  /** the payload_sha256 shown to the seller: the approval is bound to it */
  reviewedSha: string;
  onClose: () => void;
  onApproved: () => void;
  onRefused: (code: string) => void;
}) {
  const t = useTranslations("disputes.confirm");
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) {
      d.showModal();
      back.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  async function send(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    const target = await currentActionId(disputeId, actionId);
    const res = await postJson(
      `/api/actions/${target}/approve`,
      { payload_sha256: reviewedSha },
      key.current,
    );
    setBusy(false);
    key.current = null;
    onClose();
    if (res.status === 200) onApproved();
    else
      onRefused(
        res.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(res.body) ?? `HTTP_${String(res.status)}`),
      );
  }

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
      data-testid="approve-dialog"
    >
      <h2 id={`${id}-title`} className="mb-2 text-lg font-semibold">
        {t("title")}
      </h2>
      <p id={`${id}-body`} className="mb-2">
        {t("body")}
      </p>
      <p className="mb-4 text-sm text-text-muted">
        <code className="font-mono">{t("fingerprint", { fp: fingerprint(reviewedSha) })}</code>
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          ref={back}
          type="button"
          onClick={onClose}
          className="min-h-12 rounded-md border border-border-strong px-4 font-medium"
        >
          {t("back")}
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          aria-busy={busy || undefined}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-on-accent disabled:opacity-70"
          data-testid="approve-send"
        >
          {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
          {busy ? t("sending") : t("send")}
        </button>
      </div>
    </dialog>
  );
}
