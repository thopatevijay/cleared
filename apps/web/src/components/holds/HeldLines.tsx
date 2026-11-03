"use client";
// The dashboard's held-row lines (dashboard.md elements 7–10, M3-01): `EstimatedDate` ("Free by … ·
// estimated · Source"), the advice line "Don't ship yet" only when the cited rule's source carries it
// (with that source), "Tracking can help release this" on goods holds, and the single row action "Why?"
// → the hold detail's explanation section. M3-03 (elements 11–12): on a goods hold not yet filed, the
// route-advice line and "File tracking" (→ the hold detail's `add_tracking` ApprovalCard) replace "Why?";
// once tracking is filed both are gone. BL-01 6570499264: a hold the seller declared goods shows "You marked
// this as goods" and gets the same action, with neutral route copy (no release-speed claim).
import { guidedAction, holdTypeOf, type PaymentHold } from "@cleared/core";
import { DeclaredLine } from "./DeclarationControl.tsx";
import { Truck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import { RouteAdviceLine } from "../tracking/RouteAdvice.tsx";
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
    <div className="flex flex-col items-start text-sm" data-testid="advice-line">
      <p className="flex items-start gap-2">
        <span className="flex h-[1lh] shrink-0 items-center">
          <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.75} className="text-status-held-fg" />
        </span>
        <span className="font-medium">{t("dontShip")}</span>
      </p>
      <RuleSource source={source} />
    </div>
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
  // BL-01 6570499264: a hold the seller declared goods gets tracking too, but no release-speed copy
  const typed = holdTypeOf(hold.type);
  const guided = hold.guidedAction ?? guidedAction(typed, null);
  const tracking = guided === "tracking" ? (hold.tracking ?? null) : null;
  const toFile = tracking !== null && tracking.state !== "filed";
  const declared = hold.declaration?.kind ?? null;
  return (
    <div className="flex flex-col items-start gap-2" data-testid="held-lines" data-hold={hold.id}>
      <EstimatedDate e={{ ...hold, disputeDueAt }} timeZone={timeZone} />
      <AdviceLine ruleId={hold.ruleId} />
      {declared === null ? null : <DeclaredLine kind={declared} compact />}
      {typed === "goods" && tracking?.state !== "filed" ? <TrackingHint /> : null}
      {tracking === null ? null : <RouteAdviceLine s={tracking} releaseClaims={typed === "goods"} />}
      {action && toFile ? (
        <Link
          href={`/holds/${hold.id}#tracking`}
          aria-label={t("tracking.fileTrackingName", { amount })}
          className="inline-flex min-h-11 items-center rounded-md border border-border-strong bg-surface px-4 font-medium"
          data-testid="file-tracking"
          data-row-action=""
        >
          {t("tracking.fileTracking")}
        </Link>
      ) : action ? (
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
