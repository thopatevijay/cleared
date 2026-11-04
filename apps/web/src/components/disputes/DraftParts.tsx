"use client";
// The ApprovalCard's parts (components.md): the notes with their live count, the evidence items with their
// checkboxes and file links, and the draft fingerprint. Model output and seller text are plain text only.
import { FilePlus, Info, Quote } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import { useEffect, useId, useRef, useState } from "react";
import {
  codePointCount,
  fingerprint,
  NOTES_MAX,
  NOTES_WARN_AT,
  type DraftItem,
} from "../../lib/dispute-view.ts";
import { formatBytes, formatTime } from "../../lib/format.ts";
import { useUiLocale } from "./text.ts";

/** The notes' character count ("1,500"): Latin digits in both locales. */
const COUNT = new Intl.NumberFormat("en-US");

export function NotesField({
  value,
  readOnly,
  onChange,
  onBlur,
}: {
  value: string;
  readOnly: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const t = useTranslations("disputes.draft");
  const id = useId();
  const n = codePointCount(value);
  const over = n > NOTES_MAX;
  const [spoken, setSpoken] = useState("");
  const band = over ? "over" : n >= NOTES_WARN_AT ? "near" : "ok";
  const last = useRef(band);
  useEffect(() => {
    // announced only when the count enters 1900+ or goes over 2000, never on every keystroke
    if (band !== last.current && band !== "ok") setSpoken(band === "over" ? t("over") : t("near", { n }));
    last.current = band;
  }, [band, n, t]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-notes`} className="font-medium">
        {t("notesLabel")}
      </label>
      {/* M4-03: the reply is filed in English whatever the UI language */}
      <p id={`${id}-lang`} className="text-sm text-text-muted" data-testid="notes-english">
        {t("notesEnglish")}
      </p>
      <textarea
        id={`${id}-notes`}
        value={value}
        readOnly={readOnly}
        rows={10}
        lang="en"
        aria-describedby={`${id}-lang ${id}-count`}
        aria-invalid={over || undefined}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onBlur={onBlur}
        className={`min-h-[240px] w-full rounded-md border bg-surface p-3 leading-relaxed ${over ? "border-danger" : "border-border-strong"} read-only:bg-surface-sunken`}
        data-testid="notes"
      />
      <p
        id={`${id}-count`}
        className={`tabular py-1 text-sm ${over ? "font-semibold text-danger" : "text-text-muted"}`}
        data-testid="notes-count"
        data-over={over}
      >
        {t("count", { n: COUNT.format(n) })}
        {over ? <span className="ml-2">{t("over")}</span> : null}
      </p>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
    </div>
  );
}

/** One item's links: its entry in the proof pack (citation) and its file, when it has one. */
function ItemLinks({ i }: { i: DraftItem }) {
  const t = useTranslations("disputes.draft");
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      {i.packUrl === null ? null : (
        <Link
          href={i.packUrl}
          className="inline-flex min-h-11 items-center gap-1 rounded-sm bg-surface-sunken px-2 text-sm text-accent underline underline-offset-2"
          data-testid="evidence-citation"
        >
          <Quote aria-hidden="true" size={14} strokeWidth={1.75} />
          {t("packLink", { ref: i.ref })}
        </Link>
      )}
      {i.fileUrl === null ? (
        <span className="text-sm text-text-muted">{t("noFile")}</span>
      ) : (
        <a
          href={i.fileUrl}
          download
          className="inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-2"
          data-testid="evidence-download"
        >
          {t("openItem", { ref: i.ref })}
        </a>
      )}
    </span>
  );
}

/**
 * BL-01 6595501766: "Added by Cleared" on the client sign-off / scope snapshot code added to the agent's draft,
 * or why it is not in the reply (PayPal's limits). Plain text; never only colour.
 */
function AutoNote({ i }: { i: DraftItem }) {
  const t = useTranslations("disputes.draft");
  const locale = useUiLocale();
  if (i.auto === null) return null;
  if (i.auto.state === "added")
    return (
      <span className="flex items-center gap-1 text-sm text-text-muted" data-testid="evidence-auto-added">
        <FilePlus aria-hidden="true" size={14} strokeWidth={1.75} />
        {t("autoAdded")}
      </span>
    );
  const size = formatBytes(locale, i.auto.bytes ?? 0);
  return (
    <span className="flex items-start gap-1 text-sm text-text-muted" data-testid="evidence-auto-left-out">
      <Info aria-hidden="true" size={14} strokeWidth={1.75} className="mt-1 shrink-0" />
      {t(`autoLeftOut.${i.auto.code ?? "unreadable"}`, { size })}
    </span>
  );
}

function useItemLabel(timeZone: string) {
  const t = useTranslations("disputes.draft");
  const locale = useUiLocale();
  return (i: DraftItem): string =>
    t("item", {
      ref: i.ref,
      kind: t.has(`kinds.${i.kind}`) ? t(`kinds.${i.kind}`) : i.kind,
      date: formatTime(locale, i.addedAt, timeZone),
    });
}

/**
 * The evidence items. `select`: checkboxes (the draft's selection; the helper only while editable).
 * `download`: a read-only list to reply in PayPal yourself ("draft unavailable").
 */
export function EvidenceItems({
  items,
  selected,
  readOnly,
  timeZone,
  onToggle,
  mode = "select",
}: {
  items: readonly DraftItem[];
  selected: ReadonlySet<string>;
  readOnly: boolean;
  timeZone: string;
  onToggle: (id: string) => void;
  mode?: "select" | "download";
}) {
  const t = useTranslations("disputes.draft");
  const label = useItemLabel(timeZone);
  if (mode === "download") {
    return (
      <section className="flex flex-col gap-1" data-testid="evidence-download-list">
        <h3 className="font-medium">{t("items")}</h3>
        <p className="text-sm text-text-muted">{t("downloadHint")}</p>
        <ul className="flex flex-col">
          {items.map((i) => (
            <li key={i.id} className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
              <span>{label(i)}</span>
              <ItemLinks i={i} />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="font-medium">{t("items")}</legend>
      {readOnly ? null : <p className="text-sm text-text-muted">{t("itemsHint")}</p>}
      {items.some((i) => i.auto !== null) ? (
        <p className="text-sm text-text-muted" data-testid="evidence-auto-hint">
          {t("autoHint")}
        </p>
      ) : null}
      <ul className="flex flex-col" data-testid="evidence-items">
        {items.map((i) => (
          <li
            key={i.id}
            className="flex min-h-14 flex-col gap-1 border-b border-border py-1 last:border-b-0 md:flex-row md:flex-wrap md:items-center md:gap-x-3"
          >
            <label className="flex min-h-11 items-center gap-3 md:flex-1">
              <input
                type="checkbox"
                checked={selected.has(i.id)}
                disabled={readOnly}
                onChange={() => {
                  onToggle(i.id);
                }}
                className="h-6 w-6 shrink-0 accent-[var(--color-accent)]"
                data-testid="evidence-toggle"
              />
              <span className="flex flex-col">
                <span>{label(i)}</span>
                <AutoNote i={i} />
              </span>
            </label>
            <span className="pl-9 md:pl-0">
              <ItemLinks i={i} />
            </span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

export function Fingerprint({ sha, previous }: { sha: string; previous: string | null }) {
  const t = useTranslations("disputes.draft");
  const tc = useTranslations("common");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1" data-testid="fingerprint-block">
      <p className="flex flex-wrap items-center gap-2">
        <span>{t("fingerprint")}</span>
        <code className="font-mono text-lg font-semibold" data-testid="fingerprint">
          {fingerprint(sha)}
        </code>
        {previous === null ? null : (
          <del className="font-mono text-sm text-text-muted" data-testid="fingerprint-old">
            <span className="sr-only">{t("oldFingerprint", { fp: previous })}</span>
            <span aria-hidden="true">{previous}</span>
          </del>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(sha).then(() => {
              setCopied(true);
            });
          }}
          className="min-h-11 rounded-md border border-border px-3 text-sm text-accent"
        >
          {copied ? tc("copied") : t("copyHash")}
        </button>
      </p>
      <p className="text-sm text-text-muted">{t("fingerprintNote")}</p>
    </div>
  );
}
