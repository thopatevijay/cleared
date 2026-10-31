"use client";
// A citation chip (payment-detail.md §3): the verified quote highlighted with `<mark>`, cut from the
// evidence text at M2-04's offsets. Enter expands it to the quote in context; Escape collapses it.
// "Open in evidence" scrolls to and focuses the evidence item. Plain text only: quotes are evidence data.
import type { PackCitation } from "@cleared/core";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

/** Scrolls to the evidence item, focuses it and outlines it for 2 s (no motion under reduced motion). */
export function openEvidence(evidenceItemId: string): void {
  const el = document.getElementById(`evidence-${evidenceItemId}`);
  if (el === null) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  el.focus({ preventScroll: true });
  el.classList.add("evidence-target");
  window.setTimeout(() => {
    el.classList.remove("evidence-target");
  }, 2000);
}

export function Citation({ c, from }: { c: PackCitation; from: string }) {
  const t = useTranslations("pack.citation");
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const ctx = c.context;
  return (
    <div
      className="flex w-full flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3"
      data-testid="citation"
      data-evidence-id={c.evidenceItemId}
      data-start={c.offsets.start}
      data-end={c.offsets.end}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        setOpen(false);
        toggle.current?.focus();
      }}
    >
      <p className="text-xs text-text-muted">{t("from", { kind: from })}</p>
      <p id={id} className="break-words whitespace-pre-wrap">
        {open && ctx !== null ? <span className="text-text-muted">{ctx.before}</span> : null}
        {ctx !== null ? (
          <>
            <span className="sr-only">{t("quoted")} </span>
            <mark className="rounded-sm bg-highlight px-0.5 text-text" data-testid="quote">
              {ctx.quote}
            </mark>
          </>
        ) : (
          <span className="text-text-muted">{t("noText")}</span>
        )}
        {open && ctx !== null ? <span className="text-text-muted">{ctx.after}</span> : null}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {ctx !== null ? (
          <button
            ref={toggle}
            type="button"
            className="min-h-11 text-accent underline underline-offset-2"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? t("collapse") : t("expand")}
          </button>
        ) : null}
        <a
          href={`#evidence-${c.evidenceItemId}`}
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
          onClick={(e) => {
            e.preventDefault();
            openEvidence(c.evidenceItemId);
          }}
        >
          {t("open")}
        </a>
      </div>
    </div>
  );
}
