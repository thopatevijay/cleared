"use client";
// Filing status (dispute-review.md §3): a vertical stepper of Cleared's own action states, a real sequence:
// proposed → approved → sending → (checking with PayPal) → filed, or not sent with the localised refusal
// and PayPal's debug_id. A failure is terminal at M2-08: the next step is a new proposal and a new approval
// ("Review and approve again"), never a retry of the old one (BL-01 6537331741).
import { Check, CircleX, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import type { ActionViewData } from "../../lib/dispute-view.ts";
import { formatTime } from "../../lib/format.ts";
import { useDisputeText, useUiLocale } from "./text.ts";

type Step = "proposed" | "approved" | "executing" | "unknown" | "succeeded" | "failed";

function stepsFor(state: string): { steps: Step[]; current: number } {
  const base: Step[] = ["proposed", "approved", "executing"];
  if (state === "unknown") return { steps: [...base, "unknown", "succeeded"], current: 3 };
  if (state === "failed") return { steps: [...base, "failed"], current: 3 };
  const steps: Step[] = [...base, "succeeded"];
  const at = { proposed: 0, approved: 1, executing: 2, succeeded: 3 }[state] ?? 0;
  return { steps, current: at };
}

export function FilingStatus({
  action,
  timeZone,
  canRepropose,
  reproposing,
  onRepropose,
}: {
  action: ActionViewData | null;
  timeZone: string;
  canRepropose: boolean;
  reproposing: boolean;
  onRepropose: () => void;
}) {
  const t = useTranslations("disputes.status");
  const text = useDisputeText();
  const locale = useUiLocale();
  const [announce, setAnnounce] = useState("");
  const seen = useRef<string | null>(null);
  const state = action?.state ?? null;
  useEffect(() => {
    if (state === null) return;
    if (seen.current !== null && seen.current !== state && state !== "rejected")
      setAnnounce(t(state as Step));
    seen.current = state;
  }, [state, t]);

  if (action === null || state === null || state === "rejected") {
    return <p className="text-text-muted">{state === "rejected" ? t("rejected") : t("none")}</p>;
  }
  const { steps, current } = stepsFor(state);
  const debugId = action.execution?.paypalDebugId ?? null;
  const detail = (s: Step): string | null => {
    if (s === "proposed") return t("proposedDetail");
    if (s === "approved" && action.approval !== null)
      return t("approvedDetail", { time: formatTime(locale, action.approval.approvedAt, timeZone) });
    if (s === "executing") return t("executingDetail");
    if (s === "unknown") return t("unknownDetail");
    if (s === "succeeded") return t("succeededDetail", { id: debugId ?? "—" });
    return null;
  };
  return (
    <div className="flex flex-col gap-3" data-testid="filing-status" data-state={state}>
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const done = i < current || (i === current && s === "succeeded");
          const active = i === current;
          const Icon = s === "failed" ? CircleX : done ? Check : active ? Loader2 : null;
          return (
            <li key={s} aria-current={active ? "step" : undefined} className="flex gap-3" data-step={s}>
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${s === "failed" ? "border-status-error-fg text-status-error-fg" : done ? "border-status-completed-fg bg-status-completed-bg text-status-completed-fg" : active ? "border-accent text-accent" : "border-border text-text-muted"}`}
              >
                {Icon === null ? null : (
                  <Icon
                    size={14}
                    strokeWidth={2}
                    className={Icon === Loader2 && s !== "proposed" ? "spin" : ""}
                  />
                )}
              </span>
              <span className="flex flex-col">
                <span className={active ? "font-semibold" : i > current ? "text-text-muted" : ""}>
                  {t(s)}
                </span>
                {active || (done && s !== "proposed") ? (
                  <span className="text-sm text-text-muted">{detail(s)}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {state === "failed" ? (
        <div className="flex flex-col gap-2 rounded-md bg-status-error-bg p-3 text-status-error-fg">
          <p role="alert" data-testid="filing-refusal">
            {text.refusal(action.refusal ?? "other")}
          </p>
          {debugId === null ? null : (
            <p className="font-mono text-xs break-all">{t("debugId", { id: debugId })}</p>
          )}
          {canRepropose ? (
            <button
              type="button"
              onClick={onRepropose}
              disabled={reproposing}
              aria-busy={reproposing || undefined}
              className="min-h-12 self-start rounded-md border border-border-strong bg-surface px-4 font-medium text-accent"
              data-testid="repropose"
            >
              {reproposing ? t("reproposeBusy") : t("repropose")}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="text-xs text-text-muted">{t("ours")}</p>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  );
}
