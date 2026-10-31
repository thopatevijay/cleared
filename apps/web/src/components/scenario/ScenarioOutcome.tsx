// The scenario outcome block (M2-10): PayPal's resolution in honest words ("seller keeps the money
// (PayPal covered the case)" only for RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL) with PayPal's own
// outcome code beside it, then the hold as the mirrored capture reads now. Nothing here sets an outcome.
import type { ScenarioView as View } from "@cleared/core";
import { useTranslations } from "next-intl";
import { StatusBadge } from "../StatusBadge.tsx";

export function ScenarioOutcome({ s }: { s: View }) {
  const t = useTranslations("scenario");
  if (s.outcome === null) return null;
  const sentence =
    s.outcome === "payout_paypal_covered"
      ? t("outcomePayout")
      : t("outcomeOther", { code: s.dispute?.outcome?.outcome_code ?? "" });
  const o = s.dispute?.outcome ?? null;
  return (
    <section
      aria-labelledby="outcome-heading"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      data-testid="scenario-outcome"
    >
      <h2 id="outcome-heading" className="sr-only">
        {t("step.outcome")}
      </h2>
      <StatusBadge status="resolved" detail={s.dispute?.status ?? null} />
      <p className="font-medium">
        {sentence}
        {o === null ? null : (
          <span className="mt-1 block font-mono text-xs font-normal break-words text-text-muted">
            {o.outcome_reason === null ? o.outcome_code : `${o.outcome_code} / ${o.outcome_reason}`}
          </span>
        )}
      </p>
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
