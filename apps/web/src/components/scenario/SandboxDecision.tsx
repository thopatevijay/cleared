"use client";
// "Simulate PayPal's decision (sandbox only)" (dispute-review.md §5, M2-10): a Sandbox-variant control,
// absent outside the sandbox (`decision.shown`), disabled with the reason until the workspace owns the
// dispute, its evidence is filed and PayPal offers `adjudicate` (the API refuses on the same rule). It asks
// for confirmation first; the outcome is only ever shown from PayPal's mirrored state, never set here.
import type { ScenarioView } from "@cleared/core";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { newKey, postJson } from "../../lib/api.ts";
import { SandboxBadge } from "../SandboxBadge.tsx";

export function SandboxDecision({
  scenarioId,
  decision,
  onRequested,
}: {
  scenarioId: string;
  decision: ScenarioView["decision"];
  onRequested: () => void;
}) {
  const t = useTranslations("scenario");
  const helpId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!decision.shown) return null;
  // before PayPal has opened the dispute, the spec's "not ready" wording applies too
  const reason = decision.reason === "no_dispute" ? "no_adjudicate_link" : decision.reason;

  function open(): void {
    dialog.current?.showModal();
    cancel.current?.focus();
  }

  async function confirm(): Promise<void> {
    dialog.current?.close();
    key.current ??= newKey();
    setBusy(true);
    setFailed(false);
    const res = await postJson(`/api/scenarios/${scenarioId}/decide`, {}, key.current);
    setBusy(false);
    key.current = null;
    if (res.status === 202 || res.status === 409) onRequested();
    else setFailed(true);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="sandbox-decision">
      <button
        type="button"
        onClick={open}
        disabled={!decision.enabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={helpId}
        className="inline-flex min-h-12 w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border-[1.5px] border-dashed border-border-strong bg-status-sandbox-bg px-4 py-2 font-medium text-status-sandbox-fg disabled:bg-surface-sunken disabled:text-text-muted"
      >
        {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
        <span className="text-center">{busy ? t("sending") : t("decide")}</span>
        <SandboxBadge decorative />
      </button>
      <div id={helpId} className="flex flex-col gap-1 text-sm text-text-muted">
        <p>{t("decideHelp")}</p>
        {reason !== null && reason !== "not_sandbox" ? (
          <p data-testid="decision-reason">{t(`blocked.${reason}`)}</p>
        ) : null}
        {decision.error !== null && reason !== "already_requested" ? (
          <p className="text-danger">{t("decisionError", { code: decision.error })}</p>
        ) : null}
        {failed ? <p className="text-danger">{t("decisionError", { code: "NETWORK" })}</p> : null}
      </div>
      <dialog
        ref={dialog}
        aria-labelledby={`${helpId}-title`}
        className="m-auto max-w-[480px] rounded-lg border border-border bg-surface p-5 text-text backdrop:bg-black/40"
      >
        <h2 id={`${helpId}-title`} className="mb-2 text-lg font-semibold">
          {t("decide")}
        </h2>
        <p className="mb-4">{t("decideConfirm")}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={() => dialog.current?.close()}
            className="min-h-11 rounded-md border border-border px-4"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            className="min-h-11 rounded-md border-[1.5px] border-dashed border-border-strong bg-status-sandbox-bg px-4 font-medium text-status-sandbox-fg"
          >
            {t("confirm")}
          </button>
        </div>
      </dialog>
    </div>
  );
}
