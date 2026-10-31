"use client";
// The ApprovalCard's parts (components.md): the notes with their live count, the evidence items with their
// checkboxes and file links, and the draft fingerprint. Model output and seller text are plain text only.
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import {
  codePointCount,
  fingerprint,
  NOTES_MAX,
  NOTES_WARN_AT,
  type DraftItem,
} from "../../lib/dispute-view.ts";
import { formatTime } from "../../lib/format.ts";
import { useUiLocale } from "./text.ts";

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
      <textarea
        id={`${id}-notes`}
        value={value}
        readOnly={readOnly}
        rows={10}
        aria-describedby={`${id}-count`}
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
        className={`tabular sticky bottom-0 bg-surface py-1 text-sm ${over ? "font-semibold text-danger" : "text-text-muted"}`}
        data-testid="notes-count"
        data-over={over}
      >
        {t("count", { n: n.toLocaleString("en-US") })}
        {over ? <span className="ml-2">{t("over")}</span> : null}
      </p>
      <p aria-live="polite" className="sr-only">
        {spoken}
      </p>
    </div>
  );
}

export function EvidenceItems({
  items,
  selected,
  readOnly,
  timeZone,
  onToggle,
}: {
  items: readonly DraftItem[];
  selected: ReadonlySet<string>;
  readOnly: boolean;
  timeZone: string;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("disputes.draft");
  const locale = useUiLocale();
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="font-medium">{t("items")}</legend>
      <p className="text-sm text-text-muted">{t("itemsHint")}</p>
      <ul className="flex flex-col" data-testid="evidence-items">
        {items.map((i) => (
          <li
            key={i.id}
            className="flex min-h-14 flex-wrap items-center gap-x-3 border-b border-border py-1 last:border-b-0"
          >
            <label className="flex min-h-11 flex-1 items-center gap-3">
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
              <span>
                {t("item", { ref: i.ref, kind: i.kind, date: formatTime(locale, i.addedAt, timeZone) })}
              </span>
            </label>
            {i.fileUrl === null ? (
              <span className="text-sm text-text-muted">{t("noFile")}</span>
            ) : (
              <a
                href={i.fileUrl}
                className="inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-2"
              >
                {t("openItem", { ref: i.ref })}
              </a>
            )}
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
          className="min-h-11 rounded-md border border-border px-3 text-sm text-accent md:min-h-8"
        >
          {copied ? tc("copied") : t("copyHash")}
        </button>
      </p>
      <p className="text-sm text-text-muted">{t("fingerprintNote")}</p>
    </div>
  );
}
