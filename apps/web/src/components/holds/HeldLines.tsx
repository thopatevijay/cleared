"use client";
// The dashboard's held-row lines (dashboard.md elements 7–10, M3-01): `EstimatedDate` ("Free by … ·
// estimated · Source"), the advice line "Don't ship yet" only when the cited rule's source carries it
// (with that source), "Tracking can help release this" on goods holds (M3-03 adds the action), and the
// single row action "Why?" → the hold detail's explanation section.
import type { PaymentHold } from "@cleared/core";
import { Truck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import { EstimatedDate } from "./EstimatedDate.tsx";
import { RuleSource } from "./RuleSource.tsx";
import { ruleOf } from "./text.ts";

/** Element 9: shown only when a cited source of the hold's rule carries the advice. */
export function AdviceLine({ ruleId }: { ruleId: string }) {
  const t = useTranslations("holds");
  const rule = ruleOf(ruleId);
  const advice = rule?.advice ?? null;
  const source = advice === null ? undefined : rule?.sources[advice.sourceIndex];
  if (advice === null || source === undefined) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="advice-line">
      <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.75} className="text-status-held-fg" />
      <span className="font-medium">{t("dontShip")}</span>
      <RuleSource source={source} />
    </p>
  );
}

export function TrackingHint() {
  const t = useTranslations("holds");
  return (
    <p className="flex items-center gap-2 text-sm" data-testid="tracking-hint">
      <Truck aria-hidden="true" size={16} strokeWidth={1.75} className="text-text-muted" />
      {t("trackingHelps")}
    </p>
  );
}

export function HeldLines({
  hold,
  amount,
  timeZone,
  action,
  disputeDueAt = null,
}: {
  hold: PaymentHold;
  /** dispute-linked holds: the reply deadline shown instead of a date */
  disputeDueAt?: string | null;
  /** "64.00 USD", for the action's accessible name */
  amount: string;
  timeZone: string;
  /** false when the row already carries another single action (a dispute's "Review and approve") */
  action: boolean;
}) {
  const t = useTranslations("holds");
  return (
    <div className="flex flex-col items-start gap-2" data-testid="held-lines" data-hold={hold.id}>
      <EstimatedDate e={{ ...hold, disputeDueAt }} timeZone={timeZone} />
      <AdviceLine ruleId={hold.ruleId} />
      {hold.type === "goods" ? <TrackingHint /> : null}
      {action ? (
        <Link
          href={`/holds/${hold.id}#why`}
          aria-label={t("whyName", { amount })}
          className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 font-medium"
          data-testid="why"
          data-row-action=""
        >
          {t("why")}
        </Link>
      ) : null}
    </div>
  );
}
