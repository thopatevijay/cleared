"use client";
// EstimatedDate (components.md): the date, the word "estimated" (always visible) and the rule's Source.
// Dashed boundary = not yet fact. Variants: dated ("Free by 29 Oct · estimated · Source"), the full form
// on the hold detail (the rule's sentence, e.g. "Within 24 hours; up to 3 business days", then the
// dates), dispute-linked ("Released when the dispute is resolved · Dispute reply due 2 Nov") and no
// timeline ("PayPal gives no timeline for this reason" + Source). Never an undated "~".
import { CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatDate } from "../../lib/format.ts";
import { useUiLocale } from "../disputes/text.ts";
import { RuleSource } from "./RuleSource.tsx";
import { estimateKey, ruleOf } from "./text.ts";

export interface EstimateInput {
  readonly ruleId: string;
  readonly estimatedReleaseAt: string | null;
  readonly estimateUpperBoundAt: string | null;
  /** dispute-linked holds: the seller's reply deadline */
  readonly disputeDueAt?: string | null;
}

const Dot = () => (
  <span aria-hidden="true" className="text-text-muted">
    {" · "}
  </span>
);

export function EstimatedDate({
  e,
  timeZone,
  full = false,
}: {
  e: EstimateInput;
  timeZone: string;
  full?: boolean;
}) {
  const t = useTranslations("holds");
  const locale = useUiLocale();
  const rule = ruleOf(e.ruleId);
  const source = rule?.sources[0] ?? null;
  const key = estimateKey(rule);
  const at = e.estimatedReleaseAt;
  const date = (iso: string, long = false) => formatDate(locale, iso, timeZone, long);
  const name =
    at === null
      ? t("noTimelineName", { source: source?.title ?? "" })
      : t("estimateName", { date: date(at, true), source: source?.title ?? "" });
  const due = e.disputeDueAt ?? null;
  return (
    <div
      role="group"
      aria-label={name}
      className="inline-flex max-w-full flex-col gap-1 self-start rounded-md border-[1.5px] border-dashed border-border-strong bg-surface-sunken px-3 py-1 text-sm"
      data-testid="estimated-date"
      data-rule={rule?.id}
    >
      {full || at === null ? (
        <span className="flex flex-wrap items-center gap-x-2">
          <span data-testid="estimate-sentence">{t(`est.${key}`)}</span>
          {key === "dispute" && due !== null ? (
            <>
              <Dot />
              <span>{t("disputeDue", { date: date(due) })}</span>
            </>
          ) : null}
          {at !== null ? (
            <>
              <Dot />
              <span className="font-medium">{t("estimated")}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {at !== null ? (
        <span className="flex flex-wrap items-center gap-x-2">
          <CalendarClock aria-hidden="true" size={16} strokeWidth={1.75} className="text-text-muted" />
          <span data-testid="free-by">{t("freeBy", { date: date(at) })}</span>
          {full && e.estimateUpperBoundAt !== null ? (
            <>
              <Dot />
              <span>{t("upTo", { date: date(e.estimateUpperBoundAt) })}</span>
            </>
          ) : null}
          {full ? null : (
            <>
              <Dot />
              <span className="font-medium">{t("estimated")}</span>
              {source === null ? null : (
                <>
                  <Dot />
                  <RuleSource source={source} />
                </>
              )}
            </>
          )}
        </span>
      ) : null}
      {source === null || (!full && at !== null) ? null : <RuleSource source={source} />}
    </div>
  );
}
