// Outcome (dispute-review.md §4): only from PayPal's mirrored dispute. RESOLVED_WITH_PAYOUT +
// REPRESENTED_BY_PAYPAL reads exactly "Resolved; you keep the money (PayPal covered the case)"; any other
// outcome is worded from PayPal's meaning with its code. "Hold released" only once the mirrored capture
// reads COMPLETED. Nothing here sets or infers an outcome.
import { useTranslations } from "next-intl";
import type { DisputeDetail } from "../../lib/dispute-view.ts";
import { StatusBadge } from "../StatusBadge.tsx";
import { useDisputeText } from "./text.ts";

export function Outcome({ d }: { d: DisputeDetail["dispute"] }) {
  const t = useTranslations("disputes.outcome");
  const text = useDisputeText();
  if (d.status !== "RESOLVED" || d.outcome === null) return null;
  const o = d.outcome;
  const pay = d.payment;
  return (
    <section
      aria-labelledby="outcome-heading"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      data-testid="dispute-outcome"
    >
      <h2 id="outcome-heading" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <StatusBadge status="resolved" detail={d.status} />
      <p className="font-medium" data-testid="outcome-text">
        {text.outcome(o)}
      </p>
      <p className="font-mono text-xs break-words text-text-muted">
        {o.outcome_reason === null ? o.outcome_code : `${o.outcome_code} / ${o.outcome_reason}`}
      </p>
      {pay === null ? null : pay.status === "COMPLETED" ? (
        <p className="flex flex-wrap items-center gap-2">
          <StatusBadge status="completed" detail={pay.status} />
          <span>{t("holdReleased")}</span>
        </p>
      ) : (
        <p className="text-text-muted">
          {t("holdStill", {
            status: pay.statusReason === null ? pay.status : `${pay.status} / ${pay.statusReason}`,
          })}
        </p>
      )}
    </section>
  );
}
