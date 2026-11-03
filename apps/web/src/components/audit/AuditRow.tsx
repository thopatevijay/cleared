"use client";
// Audit log row (components.md `AuditRow`): time (workspace tz, seconds), actor (icon + word), the action in
// plain words, the result, and the references (dispute ID, PayPal debug_id, fingerprint) in mono with a
// copy button each. "Details" discloses the allow-listed detail fields as plain text. Read only: no edit or
// delete affordance exists anywhere (the table is append-only).
import {
  Bot,
  ChevronDown,
  CircleCheck,
  CircleX,
  FlaskConical,
  Info,
  Server,
  User,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Link } from "../../i18n/navigation.ts";
import type { AuditEntry } from "../../lib/dispute-view.ts";
import { formatClock } from "../../lib/format.ts";
import { useAuditText, type Tone } from "./text.ts";

const ACTOR_ICON: Record<"seller" | "agent" | "system" | "sandbox", LucideIcon> = {
  seller: User,
  agent: Bot,
  system: Server,
  sandbox: FlaskConical,
};
const TONE: Record<Tone, { icon: LucideIcon; cls: string }> = {
  ok: { icon: CircleCheck, cls: "text-status-completed-fg" },
  bad: { icon: CircleX, cls: "text-status-error-fg" },
  neutral: { icon: Info, cls: "text-text-muted" },
  sandbox: { icon: FlaskConical, cls: "text-status-sandbox-fg" },
};

function CopyId({ label, value }: { label: string; value: string }) {
  const t = useTranslations("auditLog");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
        });
      }}
      className="min-h-11 min-w-11 rounded-md border border-border px-3 text-sm text-accent"
    >
      {copied ? t("copied") : <span>{t("copyId", { label })}</span>}
    </button>
  );
}

function Ref({ label, value, href }: { label: string; value: string; href?: string | undefined }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <span className="text-xs text-text-muted">{label}</span>
      {href === undefined ? (
        <code className="font-mono text-xs [overflow-wrap:anywhere]">{value}</code>
      ) : (
        <Link
          href={href}
          className="inline-flex min-h-6 items-center font-mono text-xs text-accent underline [overflow-wrap:anywhere]"
        >
          {value}
        </Link>
      )}
      <CopyId label={label} value={value} />
    </span>
  );
}

export function AuditRow({
  e,
  locale,
  timeZone,
  disputeHref,
  compact = false,
}: {
  e: AuditEntry;
  locale: string;
  timeZone: string;
  /** the dispute page for a PayPal dispute id, when the row names one */
  disputeHref?: (paypalId: string) => string;
  /** always the stacked layout (the dispute page's narrow audit-trail column) */
  compact?: boolean;
}) {
  const t = useTranslations("auditLog");
  const text = useAuditText();
  const id = useId();
  const [open, setOpen] = useState(false);
  const r = text.result(e);
  const ActorIcon = ACTOR_ICON[e.sandbox ? "sandbox" : e.actor];
  const { icon: ToneIcon, cls } = TONE[r.tone];
  const fields = Object.entries(e.detail);
  return (
    <li
      className="flex flex-col gap-1 border-b border-border bg-surface px-4 py-3 last:border-b-0"
      data-testid="audit-row"
      data-action={e.action}
    >
      <div
        className={
          compact
            ? "flex flex-col gap-1"
            : "flex flex-col gap-1 md:grid md:grid-cols-[minmax(0,7rem)_minmax(0,9rem)_1fr] md:items-start md:gap-x-4 xl:grid-cols-[7rem_10rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)]"
        }
      >
        <time dateTime={e.at} className="tabular text-sm text-text-muted">
          {formatClock(locale, e.at, timeZone)}
        </time>
        <span className="inline-flex items-center gap-1 text-sm font-medium" data-testid="audit-actor">
          <ActorIcon aria-hidden="true" size={16} strokeWidth={1.75} />
          {text.actor(e)}
        </span>
        <span className="font-medium">{text.action(e)}</span>
        <span className={`inline-flex items-start gap-1 text-sm ${cls}`}>
          <ToneIcon aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <span className="text-text">{r.text}</span>
        </span>
        <span className={`flex min-w-0 flex-wrap gap-x-3 ${compact ? "" : "md:col-span-3 xl:col-span-1"}`}>
          {e.refs.disputeId === null ? null : (
            <Ref label={t("ref.dispute")} value={e.refs.disputeId} href={disputeHref?.(e.refs.disputeId)} />
          )}
          {e.refs.debugId === null ? null : <Ref label={t("ref.debugId")} value={e.refs.debugId} />}
          {e.refs.fingerprint === null ? null : (
            <Ref label={t("ref.fingerprint")} value={e.refs.fingerprint} />
          )}
        </span>
      </div>
      {fields.length === 0 ? null : (
        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-detail`}
            onClick={() => {
              setOpen((o) => !o);
            }}
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-accent"
          >
            <ChevronDown aria-hidden="true" size={16} className={open ? "rotate-180" : ""} />
            {open ? t("hideDetails") : t("details")}
          </button>
          <dl
            id={`${id}-detail`}
            hidden={!open}
            className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-sunken p-3 text-sm"
            data-testid="audit-detail"
          >
            {fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-xs text-text-muted">{k}</dt>
                <dd className="font-mono text-xs [overflow-wrap:anywhere]">
                  {v === null ? "null" : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}
