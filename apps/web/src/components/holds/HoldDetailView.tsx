"use client";
// Hold detail (hold.md "Detail", M3-01): header (amount, held badge + PayPal's reason, opened time, the
// payment and dispute links), "Why it's held" (M3-02's EN/HI explanation, then the rule's own words + Source),
// the estimated release in its full form, the action slot (M3-03 / M3-04 fill it), and the timeline
// mirroring the hold machine. "#why" (the dashboard's "Why?") moves focus to the explanation section.
// "Released" shows only when the hold is released, i.e. the mirrored capture left PENDING: the badge
// then mirrors the capture (COMPLETED), the old reason stays as history, and the release leads.
import { guidedAction, HOLD_STATES, type HoldDetail, type HoldState } from "@cleared/core";
import { Circle, CircleCheck, CircleDot, SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Link, useRouter } from "../../i18n/navigation.ts";
import { ApiError, getParsed } from "../../lib/api.ts";
import { formatAmount, formatDate, formatTime } from "../../lib/format.ts";
import { useUiLocale } from "../disputes/text.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { EstimatedDate } from "./EstimatedDate.tsx";
import { Explanation } from "./Explanation.tsx";
import { AdviceLine, TrackingHint } from "./HeldLines.tsx";
import { HOLDS_POLL_MS } from "./HoldsView.tsx";
import { OfflineBanner, useLoadedAt } from "./Offline.tsx";
import { RuleSource } from "./RuleSource.tsx";
import { RouteAdvice } from "../tracking/RouteAdvice.tsx";
import { TrackingCard } from "../tracking/TrackingCard.tsx";
import { GuidedCompleted } from "./GuidedCompleted.tsx";
import { DeclarationControl, ShipFirst } from "./DeclarationControl.tsx";
import { ruleOf, useReasonText } from "./text.ts";

const fetchHold = async (path: string): Promise<HoldDetail> => getParsed(path, (s) => s.HoldDetailSchema);
const linkClass = "inline-flex min-h-11 items-center text-accent underline underline-offset-2";

function Why({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const reason = useReasonText();
  const source = ruleOf(d.hold.ruleId)?.sources[0] ?? null;
  const released = d.hold.state === "released";
  return (
    <section
      id="why"
      tabIndex={-1}
      aria-labelledby="why-heading"
      className="flex scroll-mt-16 flex-col gap-2"
      data-testid="why-section"
    >
      <h2 id="why-heading" className="text-xl font-semibold">
        {released ? t("whyTitleReleased") : t("whyTitle")}
      </h2>
      <p>{reason(d.hold.reason)}</p>
      <Explanation
        holdId={d.hold.id}
        explanations={d.explanations}
        released={released}
        ruleId={d.hold.ruleId}
      />
      {source === null ? null : (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-sunken p-3">
          <p className="text-sm text-text-muted">{t("ruleText")}</p>
          <blockquote className="break-words" data-testid="rule-quote">
            {source.quote}
          </blockquote>
          <RuleSource source={source} />
        </div>
      )}
      {released ? null : <AdviceLine ruleId={d.hold.ruleId} />}
    </section>
  );
}

/** Still held after the filing, or past the latest date the rule estimates (PayPal hasn't released it). */
function stillHeld(h: HoldDetail["hold"], now: number): boolean {
  const last = h.estimateUpperBoundAt ?? h.estimatedReleaseAt;
  return h.state === "still_held" || (last !== null && Date.parse(last) < now);
}

function Estimate({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const tl = useTranslations("holds.timeline");
  const locale = useUiLocale();
  const [now] = useState(() => Date.now());
  const h = d.hold;
  const tz = d.workspace.timezone;
  return (
    <section aria-labelledby="estimate-heading" className="flex flex-col gap-2">
      <h2 id="estimate-heading" className="text-xl font-semibold">
        {h.state === "released" ? tl("released") : t("estimateTitle")}
      </h2>
      {h.state === "released" && h.releasedAt !== null ? (
        <p data-testid="released">{t("released", { time: formatTime(locale, h.releasedAt, tz) })}</p>
      ) : (
        <EstimatedDate e={{ ...h, disputeDueAt: h.dispute?.dueDate ?? null }} timeZone={tz} full />
      )}
      {h.state === "released" || !stillHeld(h, now) ? null : (
        <div className="flex flex-col gap-1" data-testid="still-held">
          <p className="font-medium">{t("stillHeld")}</p>
          <p className="text-text-muted">{t("stillHeldCheck")}</p>
        </div>
      )}
    </section>
  );
}

type StepMark = "done" | "current" | "notReached";
const MARK = { done: CircleCheck, current: CircleDot, notReached: Circle } as const;

/** The steps shown: a released hold shows only held → released (skipped steps are not claimed). */
function timelineSteps(state: HoldState): HoldState[] {
  if (state === "released") return ["open", "released"];
  const path = HOLD_STATES.filter((s) => s !== "released" && s !== "still_held");
  return state === "still_held" ? [...path, "still_held"] : [...path, "released"];
}

/** M3-04: the filed step of a service hold the seller confirmed reads as their own confirmation. */
function Timeline({ state, completedOn }: { state: HoldState; completedOn: string | null }) {
  const t = useTranslations("holds");
  const steps = timelineSteps(state);
  const at = steps.indexOf(state);
  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
      <h2 id="timeline-heading" className="text-xl font-semibold">
        {t("detail.timelineTitle")}
      </h2>
      <ol className="flex flex-col gap-2" data-testid="timeline">
        {steps.map((s, i) => {
          const mark: StepMark = i < at ? "done" : i === at ? "current" : "notReached";
          const Icon = MARK[mark];
          return (
            <li
              key={s}
              aria-current={mark === "current" ? "step" : undefined}
              className={`flex items-center gap-2 ${mark === "notReached" ? "text-text-muted" : ""}`}
              data-mark={mark}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
              <span className={mark === "current" ? "font-semibold" : ""} data-testid="step-label">
                {s === "filed" && completedOn !== null
                  ? t("completed.timeline", { date: completedOn })
                  : t(`timeline.${s}`)}
              </span>
              <span className="text-sm text-text-muted">
                {"("}
                {t(`step.${mark}`)}
                {")"}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Header({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const locale = useUiLocale();
  const h = d.hold;
  const f = formatAmount(locale, h.amount);
  const released = h.state === "released";
  return (
    <header className="flex flex-col gap-2">
      <h1 className="tabular text-2xl font-bold">
        {t(released ? "h1Released" : "h1", { amount: `${f.text} ${f.code}` })}
      </h1>
      {/* the badge mirrors the capture now; a released hold keeps its old reason as history */}
      <StatusBadge status={released ? "completed" : "held"} detail={released ? d.payment.status : h.reason} />
      {released ? (
        <p className="text-sm text-text-muted" data-testid="was-held">
          {t("wasHeld")} <code lang="en">{h.reason}</code>
        </p>
      ) : null}
      <p className="text-sm text-text-muted">
        <time dateTime={h.openedAt}>
          {t("opened", { time: formatTime(locale, h.openedAt, d.workspace.timezone) })}
        </time>
      </p>
      <p className="flex flex-wrap gap-x-4">
        <Link href={`/payments/${h.paymentId}/pack`} className={linkClass}>
          {t("payment")}
        </Link>
        {h.dispute === null ? null : (
          <Link href={`/disputes/${h.dispute.id}`} className={linkClass} data-testid="dispute-link">
            {t("dispute", { id: h.dispute.disputeId })}
          </Link>
        )}
      </p>
    </header>
  );
}

/**
 * M3-03: the tracking action slot: route advice, then the `add_tracking` ApprovalCard. The release-speed copy
 * ("Tracking can help release this", "Faster release expected") shows only on a hold PayPal typed goods,
 * never on a hold the seller declared goods (e.g. a payment review: ADR 0017 addendum 3).
 */
function GoodsAction({ d, onChanged }: { d: HoldDetail; onChanged: () => void }) {
  const tracking = d.hold.tracking ?? null;
  const claims = d.hold.type === "goods";
  if (tracking === null) return claims ? <TrackingHint /> : null;
  return (
    <>
      {tracking.state === "filed" || !claims ? null : <TrackingHint />}
      {claims || tracking.state === "filed" || ruleOf(d.hold.ruleId)?.advice?.kind !== "dont_ship" ? null : (
        <ShipFirst />
      )}
      <RouteAdvice s={tracking} releaseClaims={claims} />
      <TrackingCard hold={d.hold} onChanged={onChanged} />
    </>
  );
}

/** The action slot's content: PayPal's type picks the action, else the seller's declaration. */
function ActionSlot({ d, onChanged }: { d: HoldDetail; onChanged: () => void }) {
  const t = useTranslations("holds.detail");
  const h = d.hold;
  const action = h.guidedAction ?? guidedAction(h.type, null);
  return (
    <>
      <DeclarationControl d={d} onChanged={onChanged} />
      {action === "tracking" ? (
        <GoodsAction d={d} onChanged={onChanged} />
      ) : action === "completed" && h.completed != null ? (
        <GuidedCompleted d={d} onChanged={onChanged} />
      ) : (
        // answering is optional: until the seller does, nothing is needed from them
        <p className={h.declaration?.declarable === true ? "mt-2" : undefined}>{t("nothingToDo")}</p>
      )}
    </>
  );
}

function Detail({ d, onChanged }: { d: HoldDetail; onChanged: () => void }) {
  const t = useTranslations("holds.detail");
  const locale = useUiLocale();
  const h = d.hold;
  const released = h.state === "released";
  return (
    <div className="flex flex-col gap-6" data-testid="hold-detail" data-state={h.state}>
      <Header d={d} />
      {released ? <Estimate d={d} /> : null}
      <Why d={d} />
      {released ? null : <Estimate d={d} />}
      {released ? null : (
        <section aria-labelledby="action-heading" className="flex flex-col gap-2" data-testid="action-slot">
          <h2 id="action-heading" className="text-xl font-semibold">
            {t("actionTitle")}
          </h2>
          <ActionSlot d={d} onChanged={onChanged} />
        </section>
      )}
      <Timeline
        state={h.state}
        completedOn={
          h.completed?.confirmedAt == null
            ? null
            : formatDate(locale, h.completed.confirmedAt, d.workspace.timezone)
        }
      />
    </div>
  );
}

export function HoldDetailView({ id }: { id: string }) {
  const t = useTranslations("holds");
  const router = useRouter();
  const { data, error, isValidating, mutate } = useSWR<HoldDetail, unknown>(`/api/holds/${id}`, fetchHold, {
    refreshInterval: HOLDS_POLL_MS,
    refreshWhenHidden: false,
    keepPreviousData: true,
  });
  const loadedAt = useLoadedAt(data);
  const focused = useRef(false);
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  useEffect(() => {
    // "#why" (the dashboard's "Why?"), "#tracking" (M3-03 "File tracking" → the ApprovalCard) or
    // "#completed" (M3-04 the guided Completed step)
    const target = window.location.hash.slice(1);
    if (data === undefined || focused.current || !["why", "tracking", "completed"].includes(target)) return;
    const el = document.getElementById(target);
    if (el === null) return;
    focused.current = true;
    el.focus();
  }, [data]);

  if (data !== undefined)
    return (
      <>
        <OfflineBanner loadedAt={loadedAt} timeZone={data.workspace.timezone} />
        <Detail d={data} onChanged={() => void mutate()} />
      </>
    );
  if (error instanceof ApiError && error.status === 404)
    return <EmptyState icon={SearchX} title={t("notFoundTitle")} body={t("notFoundBody")} />;
  if (error !== undefined)
    return (
      <ErrorPanel
        title={t("errorOneTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-4">
      <span aria-hidden="true" className="skeleton-pulse block h-24 rounded-lg" />
      <span aria-hidden="true" className="skeleton-pulse block h-48 rounded-lg" />
      <p role="status" className="text-text-muted">
        {t("loading")}
      </p>
    </div>
  );
}
