"use client";
// "Create a sandbox test payment" (Sandbox variant: dashed boundary + Sandbox badge). POSTs with one
// Idempotency-Key per click, so a double tap creates one payment. Disabled, with the reason, at 3 a day.
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { newKey, postJson } from "../lib/api.ts";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { SandboxBadge } from "./SandboxBadge.tsx";

export function TestPaymentButton({ capped, onQueued }: { capped: boolean; onQueued: () => void }) {
  const t = useTranslations();
  const reasonId = useId();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(false);
  const [failure, setFailure] = useState<{ ref: string | null } | null>(null);
  const disabled = busy || capped || limit;

  async function create(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    setFailure(null);
    const res = await postJson("/api/sandbox/test-payments", {}, key.current);
    setBusy(false);
    if (res.status === 202) {
      key.current = null;
      onQueued();
    } else if (res.status === 429) {
      setLimit(true);
    } else {
      key.current = null;
      setFailure({ ref: res.correlationId });
    }
  }

  return (
    <div className="flex w-full flex-col gap-2 md:w-auto">
      <button
        type="button"
        onClick={() => void create()}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={busy ? t("empty.busy") : t("empty.ctaName")}
        aria-describedby={capped || limit ? reasonId : undefined}
        className="inline-flex min-h-12 w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border-[1.5px] py-2 border-dashed border-border-strong bg-status-sandbox-bg px-4 font-medium text-status-sandbox-fg disabled:bg-surface-sunken disabled:text-text-muted md:w-auto"
      >
        {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
        <span className="text-center">{busy ? t("empty.busy") : t("empty.cta")}</span>
        <SandboxBadge decorative />
      </button>
      {capped || limit ? (
        <p id={reasonId} className="text-sm text-text-muted">
          {t("empty.capped")}
        </p>
      ) : null}
      {failure ? (
        <ErrorPanel title={t("dashboard.errorTitle")} body={t("landing.error")} reference={failure.ref} />
      ) : null}
    </div>
  );
}
