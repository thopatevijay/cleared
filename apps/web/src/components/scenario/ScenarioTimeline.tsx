// ScenarioTimeline (dispute-review.md §5, M2-10): each judge-scenario step with its real PayPal ids, the
// time it was observed and what PayPal reported, plus the expected wait (from the M0-05 spike) on the step
// in progress. A real sequence, so an ordered list; status is icon + text, never colour alone. Reusable on
// M2-09's dispute detail.
import type { ScenarioView } from "@cleared/core";
import { Circle, CircleCheck, CircleX, LoaderCircle, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatTime } from "../../lib/format.ts";

type Step = ScenarioView["timeline"][number];

const ICON: Readonly<Record<Step["status"], { icon: LucideIcon; tone: string }>> = {
  done: { icon: CircleCheck, tone: "text-status-completed-fg" },
  active: { icon: LoaderCircle, tone: "text-status-info-fg" },
  pending: { icon: Circle, tone: "text-text-muted" },
  failed: { icon: CircleX, tone: "text-status-error-fg" },
};

/** Steps whose wait PayPal (or the seller) controls; the copy states the measured expectation. */
const WAITS = new Set<Step["key"]>(["evidence_step", "evidence_filed", "decision", "outcome"]);

/** What each id is: the capture step carries the order then the capture; the outcome the capture. */
function idLabel(key: Step["key"], n: number): "order" | "capture" | "dispute" {
  if (key === "capture") return n === 0 ? "order" : "capture";
  return key === "outcome" ? "capture" : "dispute";
}

export function ScenarioTimeline({
  steps,
  locale,
  timeZone,
}: {
  steps: readonly Step[];
  locale: string;
  timeZone: string;
}) {
  const t = useTranslations("scenario");
  return (
    <ol className="flex flex-col" data-testid="scenario-timeline">
      {steps.map((s, i) => {
        const { icon: Icon, tone } = ICON[s.status];
        const last = i === steps.length - 1;
        // PayPal now offers `adjudicate` and the seller hasn't asked yet: say so instead of a wait
        const offered = s.key === "decision" && s.status === "active" && s.observed === "adjudicate";
        return (
          <li
            key={s.key}
            className="relative flex gap-3 pb-5 last:pb-0"
            aria-current={s.status === "active" ? "step" : undefined}
            data-step={s.key}
            data-status={s.status}
          >
            {last ? null : (
              <span aria-hidden="true" className="absolute top-7 bottom-1 left-[11px] w-px bg-border" />
            )}
            <Icon
              aria-hidden="true"
              size={24}
              strokeWidth={1.75}
              className={`relative shrink-0 bg-surface ${tone} ${s.status === "active" ? "spin" : ""}`}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium">
                {t(`step.${s.key}`)}
                <span className="sr-only">{", "}</span>
                <span className="ml-2 text-sm font-normal text-text-muted">
                  {t(`stepStatus.${s.status}`)}
                </span>
              </p>
              {s.at !== null ? (
                <p className="text-sm text-text-muted">
                  <time dateTime={s.at}>{formatTime(locale, s.at, timeZone)}</time>
                </p>
              ) : null}
              {s.paypalIds.map((id, n) => (
                <p key={id} className="text-sm">
                  <span className="text-text-muted">
                    {t(`idLabel.${idLabel(s.key, n)}`)}
                    {": "}
                  </span>
                  <span className="font-mono text-xs break-words">{id}</span>
                </p>
              ))}
              {offered ? (
                <p className="text-sm">{t("offered")}</p>
              ) : s.observed !== null && s.key !== "decision" ? (
                <p className="text-sm">
                  <span className="text-text-muted">
                    {t("observed")}
                    {": "}
                  </span>
                  <span className="font-mono text-xs break-words">{s.observed.replace(" / ", " /​ ")}</span>
                </p>
              ) : null}
              {s.status === "active" && WAITS.has(s.key) && !offered ? (
                <p className="text-sm text-text-muted">{t(`wait.${s.key as "evidence_step"}`)}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
