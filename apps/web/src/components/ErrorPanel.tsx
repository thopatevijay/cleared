"use client";
// Error panel (components.md): what happened, what to do, Retry, and the correlation id ("Reference")
// with a Copy button. `role="alert"` on the first render only, never re-announced on re-polls.
import { CircleX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

export function ErrorPanel({
  title,
  body,
  reference,
  onRetry,
  busy = false,
}: {
  title: string;
  body?: string;
  reference: string | null;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const t = useTranslations("common");
  const announced = useRef(false);
  const role = announced.current ? undefined : "alert";
  announced.current = true;
  const [copied, setCopied] = useState(false);
  return (
    <section
      role={role}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      data-testid="error-panel"
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold text-status-error-fg">
        <CircleX aria-hidden="true" size={20} strokeWidth={1.75} />
        {title}
      </h2>
      {body ? <p>{body}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            aria-busy={busy || undefined}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-4 font-medium text-accent hover:bg-surface-sunken disabled:text-text-muted"
          >
            {t("retry")}
          </button>
        ) : null}
        {reference ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-sm">
            <span className="text-text-muted">
              {t("reference")}
              {":"}
            </span>
            <code className="font-mono text-xs break-all" data-testid="correlation-id">
              {reference}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(reference).then(() => {
                  setCopied(true);
                });
              }}
              className="min-h-11 min-w-11 rounded-md border border-border-strong bg-surface px-3 font-medium text-accent hover:bg-surface-sunken"
            >
              {copied ? t("copied") : t("copy")}
            </button>
          </span>
        ) : null}
      </div>
    </section>
  );
}
