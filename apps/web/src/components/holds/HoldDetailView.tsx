"use client";
// Hold detail (hold.md "Detail", M3-01): header (amount, held badge + PayPal's reason, opened time, the
// payment and dispute links), "Why it's held" (the rule's own words + Source until M3-02's explanation),
// the estimated release in its full form, the action slot (M3-03 / M3-04 fill it), and the timeline
// mirroring the hold machine. "#why" (the dashboard's "Why?") moves focus to the explanation section.
// "Released" shows only when the hold is released, i.e. the mirrored capture left PENDING.
import { HoldDetailSchema, HOLD_STATES, type HoldDetail, type HoldState } from "@cleared/core";
import { SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { Link, useRouter } from "../../i18n/navigation.ts";
import { ApiError, getJson } from "../../lib/api.ts";
import { formatAmount, formatTime } from "../../lib/format.ts";
import { useUiLocale } from "../disputes/text.ts";
import { EmptyState } from "../EmptyState.tsx";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { EstimatedDate } from "./EstimatedDate.tsx";
import { AdviceLine, TrackingHint } from "./HeldLines.tsx";
import { HOLDS_POLL_MS } from "./HoldsView.tsx";
import { RuleSource } from "./RuleSource.tsx";
import { ruleOf, useReasonText } from "./text.ts";

const fetchHold = async (path: string): Promise<HoldDetail> => HoldDetailSchema.parse(await getJson(path));
const linkClass = "inline-flex min-h-11 items-center text-accent underline underline-offset-2";

function Why({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const reason = useReasonText();
  const source = ruleOf(d.hold.ruleId)?.sources[0] ?? null;
  return (
    <section
      id="why"
      tabIndex={-1}
      aria-labelledby="why-heading"
      className="flex scroll-mt-16 flex-col gap-2"
      data-testid="why-section"
    >
      <h2 id="why-heading" className="text-xl font-semibold">
        {t("whyTitle")}
      </h2>
      <p>{reason(d.hold.reason)}</p>
      {source === null ? null : (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-sunken p-3">
          <p className="text-sm text-text-muted">{t("ruleText")}</p>
          <blockquote className="break-words" data-testid="rule-quote">
            {source.quote}
          </blockquote>
          <RuleSource source={source} />
        </div>
      )}
      {d.hold.state === "released" ? null : <AdviceLine ruleId={d.hold.ruleId} />}
    </section>
  );
}

function Estimate({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const locale = useUiLocale();
  const h = d.hold;
  const tz = d.workspace.timezone;
  return (
    <section aria-labelledby="estimate-heading" className="flex flex-col gap-2">
      <h2 id="estimate-heading" className="text-xl font-semibold">
        {t("estimateTitle")}
      </h2>
      {h.state === "released" && h.releasedAt !== null ? (
        <p className="flex flex-wrap items-center gap-2" data-testid="released">
          <StatusBadge status="completed" detail={d.payment.status} />
          <span>{t("released", { time: formatTime(locale, h.releasedAt, tz) })}</span>
        </p>
      ) : (
        <EstimatedDate e={{ ...h, disputeDueAt: h.dispute?.dueDate ?? null }} timeZone={tz} full />
      )}
      {h.state === "still_held" ? <p>{t("stillHeld")}</p> : null}
    </section>
  );
}

function Timeline({ state }: { state: HoldState }) {
  const t = useTranslations("holds");
  const steps = HOLD_STATES.filter((s) => s !== (state === "still_held" ? "released" : "still_held"));
  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
      <h2 id="timeline-heading" className="text-xl font-semibold">
        {t("detail.timelineTitle")}
      </h2>
      <ol className="flex flex-col gap-1" data-testid="timeline">
        {steps.map((s) => (
          <li
            key={s}
            aria-current={s === state ? "step" : undefined}
            className={s === state ? "font-semibold" : "text-text-muted"}
          >
            {t(`timeline.${s}`)}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Detail({ d }: { d: HoldDetail }) {
  const t = useTranslations("holds.detail");
  const locale = useUiLocale();
  const h = d.hold;
  const f = formatAmount(locale, h.amount);
  return (
    <div className="flex flex-col gap-6" data-testid="hold-detail" data-state={h.state}>
      <header className="flex flex-col gap-2">
        <h1 className="tabular text-2xl font-bold">{t("h1", { amount: `${f.text} ${f.code}` })}</h1>
        <StatusBadge status={h.state === "released" ? "completed" : "held"} detail={h.reason} />
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
      <Why d={d} />
      <Estimate d={d} />
      {h.state === "released" ? null : (
        <section aria-labelledby="action-heading" className="flex flex-col gap-2" data-testid="action-slot">
          <h2 id="action-heading" className="text-xl font-semibold">
            {t("actionTitle")}
          </h2>
          {h.type === "goods" ? <TrackingHint /> : <p>{t("nothingToDo")}</p>}
        </section>
      )}
      <Timeline state={h.state} />
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
  const focused = useRef(false);
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/?ended=1");
  }, [error, router]);
  useEffect(() => {
    if (data === undefined || focused.current || window.location.hash !== "#why") return;
    focused.current = true;
    document.getElementById("why")?.focus();
  }, [data]);

  if (data !== undefined) return <Detail d={data} />;
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
