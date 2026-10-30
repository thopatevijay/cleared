"use client";
// "Try as demo seller" (landing.md): POST /api/demo with an Idempotency-Key (a double tap makes one
// workspace) and the browser's time zone; 201 → the dashboard. 429 → the cap copy from Retry-After.
import { Hourglass, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useRouter } from "../i18n/navigation.ts";
import { minutesFrom, NETWORK_ERROR, newKey, postJson } from "../lib/api.ts";
import { useOnline } from "../lib/use-online.ts";
import { ErrorPanel } from "./ErrorPanel.tsx";
import { SandboxBadge } from "./SandboxBadge.tsx";

/** The per-IP cap answers Retry-After: 86400; the global cap 3600 (M1-05). */
const PER_IP_RETRY_S = 3 * 3600;

type Outcome =
  { kind: "capped"; text: string; ref: string | null } | { kind: "error"; ref: string | null } | null;

export function DemoButton() {
  const t = useTranslations("landing");
  const tc = useTranslations("common");
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
    const res = await postJson("/api/demo", { timezone }, key.current);
    if (res.status === 201) {
      router.push("/payments");
      return;
    }
    setBusy(false);
    key.current = null;
    if (res.status === 429) {
      const perIp = (res.retryAfter ?? 0) > PER_IP_RETRY_S;
      setOutcome({
        kind: "capped",
        text: perIp ? t("capIp") : t("capBusy", { minutes: minutesFrom(res.retryAfter) }),
        ref: res.correlationId,
      });
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
          aria-label={busy ? t("demoBusy") : t("demoCtaName")}
          className="inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-md bg-accent px-5 text-lg font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-sunken disabled:text-text-muted md:w-auto md:self-start"
          data-testid="demo-cta"
        >
          {busy ? <Loader2 aria-hidden="true" size={18} className="spin" /> : null}
          <span>{busy ? t("demoBusy") : t("demoCta")}</span>
          <SandboxBadge decorative />
        </button>
        <p className="text-sm text-text-muted">{online ? t("demoNote") : t("offline")}</p>
      </div>
      {outcome?.kind === "capped" ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md bg-status-held-bg p-4 text-status-held-fg"
        >
          <p className="flex items-start gap-2 font-medium">
            <Hourglass aria-hidden="true" size={20} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            {outcome.text}
          </p>
          {outcome.ref ? (
            <p className="text-sm">
              {tc("reference")}: <code className="font-mono text-xs break-all">{outcome.ref}</code>
            </p>
          ) : null}
        </div>
      ) : null}
      {outcome?.kind === "error" ? (
        <ErrorPanel title={t("error")} reference={outcome.ref} onRetry={() => void start()} busy={busy} />
      ) : null}
    </div>
  );
}
