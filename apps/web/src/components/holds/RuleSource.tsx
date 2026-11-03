"use client";
// The "Source" disclosure (components.md `EstimatedDate` / `Citation`): a button that opens the rule's
// verbatim quote, its link and `retrieved_at`. Quotes are PayPal's published words, rendered as text.
import type { RuleSource as Source } from "@cleared/core";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

export function RuleSource({ source, label }: { source: Source; label?: string }) {
  const t = useTranslations("holds");
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="inline-flex flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        type="button"
        className="inline-flex min-h-11 min-w-11 items-center self-start text-accent underline underline-offset-2"
        aria-expanded={open}
        aria-controls={id}
        data-testid="source-toggle"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {label ?? t("source")}
        <span className="sr-only">
          {": "}
          {source.title}
        </span>
      </button>
      <span
        id={id}
        hidden={!open}
        className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3 text-sm text-text"
        data-testid="source-panel"
      >
        <span className="font-medium">{source.title}</span>
        <q className="break-words whitespace-pre-wrap" data-testid="source-quote">
          {source.quote}
        </q>
        {source.note ? <span className="text-text-muted">{source.note}</span> : null}
        <span className="text-text-muted">{t("sourceRetrieved", { date: source.retrieved_at })}</span>
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-11 items-center gap-1 self-start break-all text-accent underline underline-offset-2"
          data-testid="source-link"
        >
          {t("sourceOpen")}
          <ExternalLink aria-hidden="true" size={14} strokeWidth={1.75} />
        </a>
      </span>
    </span>
  );
}
