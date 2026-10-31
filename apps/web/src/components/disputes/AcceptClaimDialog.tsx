"use client";
// "Other options" → Accept claim (dispute-review.md, components.md ApprovalCard 6): Destructive, never next
// to Approve, behind a typed confirmation of the exact amount + currency ("Type 120.00 USD to confirm"). The
// button stays disabled until the text matches exactly. It creates the seller's own `accept_claim` proposal
// (M2-08) and approves it with the typed text; the server checks the same match again.
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { ActionViewSchema } from "../../lib/dispute-view.ts";
import { refusalOf, useDisputeText } from "./text.ts";

export function AcceptClaimDialog({
  disputeRowId,
  expected,
  amountText,
  allowed,
  onDone,
}: {
  disputeRowId: string;
  /** what the seller types: `<value> <currency>` as PayPal reports the dispute amount */
  expected: string | null;
  amountText: string;
  allowed: boolean;
  onDone: () => void;
}) {
  const t = useTranslations("disputes.accept");
  const text = useDisputeText();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const keys = useRef<{ propose: string; approve: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) {
      d.showModal();
      cancel.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  const matches = expected !== null && typed === expected;

  async function accept(): Promise<void> {
    if (!matches) return;
    keys.current ??= { propose: newKey(), approve: newKey() };
    setBusy(true);
    setError(null);
    const p = await postJson(
      `/api/disputes/${disputeRowId}/accept-claim-proposal`,
      { note: t("note") },
      keys.current.propose,
    );
    const action =
      p.status === 201 ? ActionViewSchema.safeParse((p.body as { action?: unknown }).action) : null;
    const a =
      action?.success === true
        ? await postJson(
            `/api/actions/${action.data.id}/approve`,
            { payload_sha256: action.data.payload_sha256, typed_confirmation: typed },
            keys.current.approve,
          )
        : p;
    setBusy(false);
    if (a.status === 200) {
      keys.current = null;
      setOpen(false);
      onDone();
      return;
    }
    setError(a.status === NETWORK_ERROR ? "NETWORK" : (refusalOf(a.body) ?? `HTTP_${String(a.status)}`));
  }

  if (!allowed || expected === null) {
    return <p className="text-sm text-text-muted">{t("notAllowed")}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="accept-claim">
      <button
        type="button"
        onClick={() => {
          setTyped("");
          setError(null);
          setOpen(true);
        }}
        className="min-h-12 self-start rounded-md border-[1.5px] border-danger px-4 font-medium text-danger"
      >
        {t("open")}
      </button>
      <dialog
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        onClose={() => {
          setOpen(false);
        }}
        className="m-auto w-[calc(100%-32px)] max-w-[480px] rounded-lg border border-border bg-surface p-5 text-text backdrop:bg-black/40"
      >
        <h2 id={`${id}-title`} className="mb-2 text-lg font-semibold">
          {t("heading")}
        </h2>
        <p id={`${id}-body`} className="mb-4">
          {t("body", { amount: amountText })}
        </p>
        <label htmlFor={`${id}-typed`} className="mb-1 block font-medium">
          {t("label", { expected })}
        </label>
        <input
          id={`${id}-typed`}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
          autoComplete="off"
          spellCheck={false}
          className="tabular mb-2 min-h-12 w-full rounded-md border border-border-strong bg-surface px-3"
          data-testid="accept-typed"
        />
        {error === null ? null : (
          <p role="alert" className="mb-2 text-sm text-danger">
            {text.refusal(error)}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancel}
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="min-h-12 rounded-md border border-border-strong px-4 font-medium"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void accept()}
            disabled={!matches || busy}
            aria-busy={busy || undefined}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-danger px-4 font-semibold text-on-danger disabled:bg-surface-sunken disabled:text-text-muted"
            data-testid="accept-confirm"
          >
            {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
            {busy ? t("busy") : t("button")}
          </button>
        </div>
      </dialog>
    </div>
  );
}
