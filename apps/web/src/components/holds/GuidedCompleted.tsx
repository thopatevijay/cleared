"use client";
// The guided Completed step (M3-04, hold.md "M3-04 guided Completed step"), the action slot of a service hold.
// A. The guide: open PayPal Activity (host per PAYPAL_ENV, from the server), find the payment by its capture
//    ID (copy), mark it Completed; PayPal support's web-path sentence verbatim with its date.
// B. Confirm: the date the seller marked it Completed (today or earlier, not before the hold opened, in the
//    workspace zone) → POST /api/holds/:id/completed. The server sets the estimate (confirmed + 7 days,
//    help129, estimated) and files the hold.
// C. Confirmed: "You marked it Completed on {date}" + the estimate; the guide stays readable on demand.
// D. Below it, always: the secondary API record, labelled "Effect on release unconfirmed" (RecordCompletedCard).
import {
  fromEpochMs,
  localDate,
  PAYPAL_SUPPORT_QUOTES,
  type HoldDetail,
  type CompletedSummary,
} from "@cleared/core";
import { CircleCheck, CircleX, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "../../i18n/navigation.ts";
import { NETWORK_ERROR, newKey, postJson } from "../../lib/api.ts";
import { formatDate } from "../../lib/format.ts";
import { useOnline } from "../../lib/use-online.ts";
import { refusalOf, useUiLocale } from "../disputes/text.ts";
import { SandboxBadge } from "../SandboxBadge.tsx";
import { EstimatedDate } from "./EstimatedDate.tsx";
import { SupportQuote, Toast, useFlash } from "./completed-parts.tsx";
import { RecordCompletedCard } from "./RecordCompletedCard.tsx";
import { RuleSource } from "./RuleSource.tsx";
import { ruleOf } from "./text.ts";

const primary =
  "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-semibold text-on-accent disabled:opacity-70 sm:w-auto";
const secondary =
  "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border-strong px-4 font-medium md:w-auto";

function CopyId({ id, onCopied }: { id: string; onCopied: () => void }) {
  const t = useTranslations("holds.completed");
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <code
        lang="en"
        className="rounded-sm bg-surface-sunken px-3 py-2 font-mono text-sm [overflow-wrap:anywhere]"
        data-testid="capture-id"
      >
        {id}
      </code>
      <button
        type="button"
        className={secondary}
        aria-label={t("copyIdLabel", { id })}
        onClick={() => {
          void navigator.clipboard.writeText(id).then(onCopied);
        }}
        data-testid="copy-id"
      >
        <Copy aria-hidden="true" size={16} strokeWidth={1.75} />
        {t("copyId")}
      </button>
    </div>
  );
}

function Guide({
  hold,
  c,
  onCopied,
}: {
  hold: HoldDetail["hold"];
  c: CompletedSummary;
  onCopied: () => void;
}) {
  const t = useTranslations("holds.completed");
  const host = new URL(c.activityUrl).host;
  const sandbox = c.env === "sandbox";
  const rule = ruleOf("service_completed");
  const step = "flex gap-3";
  const num = "tabular w-8 shrink-0 text-text-muted";
  return (
    <div className="flex flex-col gap-3" data-testid="completed-guide">
      <p className="flex flex-wrap items-center gap-x-2">
        <span>{t("intro")}</span>
        {rule === null ? null : <RuleSource source={rule.sources[0]} />}
      </p>
      <ol className="flex flex-col gap-4">
        <li className={step}>
          <span className={num} aria-hidden="true">
            1
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span>{t("step1")}</span>
            <a
              href={c.activityUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={secondary}
              aria-label={t("openActivityName", { host, sandbox: sandbox ? "yes" : "no" })}
              data-testid="activity-link"
            >
              {t("openActivity")}
              <ExternalLink aria-hidden="true" size={16} strokeWidth={1.75} />
            </a>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-text-muted" data-testid="activity-host">
                {t("opensHost", { host })}
              </span>
              {sandbox ? <SandboxBadge decorative /> : null}
            </span>
          </span>
        </li>
        <li className={step}>
          <span className={num} aria-hidden="true">
            2
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span>{t("step2")}</span>
            <CopyId id={hold.captureId} onCopied={onCopied} />
          </span>
        </li>
        <li className={step}>
          <span className={num} aria-hidden="true">
            3
          </span>
          <span className="min-w-0 flex-1">{t("step3")}</span>
        </li>
      </ol>
      <SupportQuote quote={PAYPAL_SUPPORT_QUOTES.webPath.quote} />
    </div>
  );
}

type DateError = "future" | "beforeOpened" | null;

function Confirm({
  hold,
  timeZone,
  onSaved,
}: {
  hold: HoldDetail["hold"];
  timeZone: string;
  onSaved: (estimate: string) => void;
}) {
  const t = useTranslations("holds.completed");
  const locale = useUiLocale();
  const online = useOnline();
  const id = useId();
  const [today] = useState(() => localDate(fromEpochMs(Date.now()), timeZone));
  const opened = localDate(fromEpochMs(Date.parse(hold.openedAt)), timeZone);
  const openedDate = formatDate(locale, hold.openedAt, timeZone);
  const todayDate = formatDate(locale, new Date().toISOString(), timeZone);
  const [on, setOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<DateError>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function submit(): Promise<void> {
    const local: DateError = on > today ? "future" : on < opened ? "beforeOpened" : null;
    setFieldError(local);
    if (local !== null) return;
    key.current ??= newKey();
    setBusy(true);
    const res = await postJson(`/api/holds/${hold.id}/completed`, { confirmed_on: on }, key.current);
    setBusy(false);
    key.current = null;
    if (res.status === 200) {
      setSaveError(null);
      onSaved((res.body as { estimatedReleaseAt: string }).estimatedReleaseAt);
      return;
    }
    const code = res.status === NETWORK_ERROR ? null : refusalOf(res.body);
    if (code === "DATE_IN_FUTURE") setFieldError("future");
    else if (code === "DATE_BEFORE_HOLD") setFieldError("beforeOpened");
    else setSaveError(code === null ? t("error.save") : t("error.refused", { code }));
  }
  const describedBy = [`${id}-hint`, fieldError === null ? null : `${id}-err`, online ? null : `${id}-off`]
    .filter(Boolean)
    .join(" ");
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-4"
      data-testid="completed-confirm"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <label className="flex flex-col gap-1" htmlFor={`${id}-date`}>
          <span className="font-medium">{t("dateLabel")}</span>
          <input
            id={`${id}-date`}
            type="date"
            className="min-h-12 w-full min-w-[200px] rounded-md border border-border-strong bg-surface px-3 text-text aria-invalid:border-2 aria-invalid:border-status-error-fg md:w-auto"
            value={on}
            min={opened}
            max={today}
            readOnly={busy}
            aria-invalid={fieldError === null ? undefined : true}
            aria-describedby={describedBy}
            onChange={(e) => {
              setOn(e.target.value);
            }}
            data-testid="completed-date"
          />
        </label>
        <button
          type="submit"
          className={primary}
          disabled={busy || !online}
          aria-busy={busy || undefined}
          data-testid="completed-submit"
        >
          {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
          {busy ? t("saving") : t("confirm")}
        </button>
      </div>
      <span id={`${id}-hint`} className="text-sm text-text-muted">
        {t("dateHint", { openedDate, today: todayDate })}
      </span>
      {fieldError === null ? null : (
        <p id={`${id}-err`} role="alert" className="flex items-center gap-2 text-status-error-fg">
          <CircleX aria-hidden="true" size={16} strokeWidth={1.75} />
          {fieldError === "future" ? t("error.future") : t("error.beforeOpened", { openedDate })}
        </p>
      )}
      {online ? null : (
        <p id={`${id}-off`} className="text-sm text-text-muted">
          {t("offline")}
        </p>
      )}
      {saveError === null ? null : (
        <p role="alert" className="text-status-error-fg" data-testid="completed-error">
          {saveError}
        </p>
      )}
    </form>
  );
}

function Confirmed({
  d,
  confirmedAt,
  headingRef,
  children,
}: {
  d: HoldDetail;
  confirmedAt: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  const t = useTranslations("holds.completed");
  const locale = useUiLocale();
  const [open, setOpen] = useState(false);
  const tz = d.workspace.timezone;
  return (
    <div className="flex flex-col gap-3" data-testid="completed-done">
      <h3
        id="completed-heading"
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-lg font-semibold"
        data-testid="completed-done-heading"
      >
        <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} className="text-status-completed-fg" />
        {t("done", { date: formatDate(locale, confirmedAt, tz) })}
      </h3>
      <EstimatedDate e={d.hold} timeZone={tz} />
      <div className="flex flex-col">
        <Link
          href="/audit"
          className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
        >
          {t("auditLink")}
        </Link>
        <button
          type="button"
          className="inline-flex min-h-11 items-center self-start text-sm text-accent underline underline-offset-2"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t("hideSteps") : t("showSteps")}
        </button>
      </div>
      {open ? children : null}
    </div>
  );
}

export function GuidedCompleted({ d, onChanged }: { d: HoldDetail; onChanged: () => void }) {
  const t = useTranslations("holds.completed");
  const locale = useUiLocale();
  const c = d.hold.completed ?? null;
  const [toast, flash] = useFlash();
  const [announce, setAnnounce] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const justSaved = useRef(false);
  const confirmedAt = c?.confirmedAt ?? null;
  useEffect(() => {
    if (confirmedAt === null || !justSaved.current) return;
    justSaved.current = false;
    heading.current?.focus();
  }, [confirmedAt]);
  if (c === null) return null;
  const tz = d.workspace.timezone;
  const guide = (
    <Guide
      hold={d.hold}
      c={c}
      onCopied={() => {
        flash(t("copied"));
      }}
    />
  );
  return (
    <section
      aria-labelledby={confirmedAt === null ? "completed" : "completed-heading"}
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
      data-testid="guided-completed"
      data-confirmed={confirmedAt === null ? "no" : "yes"}
    >
      {toast === null ? null : <Toast text={toast} testId="completed-toast" />}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {confirmedAt === null ? (
        <>
          <h3 id="completed" tabIndex={-1} className="scroll-mt-16 text-lg font-semibold">
            {t("title")}
          </h3>
          {guide}
          <Confirm
            hold={d.hold}
            timeZone={tz}
            onSaved={(estimate) => {
              const date = formatDate(locale, estimate, tz);
              justSaved.current = true;
              flash(t("toast", { date }));
              setAnnounce(t("announce", { date }));
              onChanged();
            }}
          />
        </>
      ) : (
        <Confirmed d={d} confirmedAt={confirmedAt} headingRef={heading}>
          {guide}
        </Confirmed>
      )}
      <RecordCompletedCard hold={d.hold} record={c.record} onChanged={onChanged} />
    </section>
  );
}
