"use client";
// Small shared parts of the guided Completed step (M3-04): the toast, its timer, and PayPal support's quote.
import { CircleCheck, Quote } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

/** A short-lived toast (hold.md Toast), announced politely. */
export function Toast({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      role="status"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm items-center gap-2 rounded-md bg-status-completed-bg p-3 font-medium text-status-completed-fg shadow-lg"
      data-testid={testId}
    >
      <CircleCheck aria-hidden="true" size={18} strokeWidth={1.75} />
      {text}
    </p>
  );
}

export function useFlash(ms = 6000): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const timer = setTimeout(() => {
      setText(null);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [text, ms]);
  return [text, setText];
}

/** A PayPal support sentence, verbatim in English, with its date (never translated). */
export function SupportQuote({ quote }: { quote: string }) {
  const t = useTranslations("holds.completed");
  return (
    <figure className="flex gap-2 rounded-md border-l-[3px] border-border-strong bg-surface-sunken p-3 text-sm">
      <Quote aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-text-muted" />
      <span className="flex min-w-0 flex-col gap-1">
        <blockquote lang="en" className="break-words" data-testid="support-quote">
          {quote}
        </blockquote>
        <figcaption className="text-text-muted">{t("supportCaption")}</figcaption>
      </span>
    </figure>
  );
}
