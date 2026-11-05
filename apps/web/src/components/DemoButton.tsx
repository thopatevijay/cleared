"use client";
// "Try as demo seller" (landing.md): POST /api/demo with an Idempotency-Key (a double tap makes one
// workspace) and the browser's time zone; 201 → the dashboard. 429 → DemoCapPanel (which cap, and when).
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useRouter } from "../i18n/navigation.ts";
import { NETWORK_ERROR, newKey, postJson } from "../lib/api.ts";
import { demoCapFrom, type DemoCap } from "../lib/demo-cap.ts";
import { useOnline } from "../lib/use-online.ts";
import { DemoCapPanel } from "./DemoCapPanel.tsx";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { SandboxBadge } from "./SandboxBadge.tsx";

type Outcome =
  | { kind: "capped"; cap: DemoCap }
  | { kind: "error"; ref: string | null }
  | null;

export function DemoButton() {
  const t = useTranslations("landing");
  const locale = useLocale();
  const router = useRouter();
  const online = useOnline();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function start(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    setOutcome(null);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // M4-03: the page language becomes the workspace locale (AI explanations, emails, PDF labels)
    const res = await postJson("/api/demo", { timezone, locale }, key.current);
    if (res.status === 201) {
      router.push("/payments");
      return;
    }
    setBusy(false);
    key.current = null;
    if (res.status === 429) {
      setOutcome({ kind: "capped", cap: demoCapFrom(res) });
    } else {
      setOutcome({ kind: "error", ref: res.status === NETWORK_ERROR ? null : res.correlationId });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || !online}
          aria-busy={busy || undefined}
          aria-label={busy ? undefined : t("demoCtaName")}
          className="inline-flex min-h-12 w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-md bg-accent px-5 py-2 text-lg font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-sunken disabled:text-text-muted md:w-auto md:self-start"
          data-testid="demo-cta"
        >
          <span className="inline-flex items-center gap-2 text-center">
            {busy ? <Loader2 aria-hidden="true" size={18} className="spin shrink-0" /> : null}
            {busy ? t("demoBusy") : t("demoCta")}
          </span>
          {" "}
          <SandboxBadge decorative />
        </button>
        <p className="text-sm text-text-muted">{online ? t("demoNote") : t("offline")}</p>
      </div>
      {outcome?.kind === "capped" ? <DemoCapPanel cap={outcome.cap} /> : null}
      {outcome?.kind === "error" ? (
        <ErrorPanel title={t("error")} reference={outcome.ref} onRetry={() => void start()} busy={busy} />
      ) : null}
    </div>
  );
}
