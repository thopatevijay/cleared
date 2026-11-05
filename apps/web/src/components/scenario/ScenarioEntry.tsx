"use client";
// "Run the dispute scenario" on the dashboard (dashboard.md, M2-10): demo and owner workspaces, sandbox
// only. One active run per workspace: while one runs, the control is a link to it. When today's global LLM
// cap is reached the button is disabled and says why. Hidden for anyone the scenario isn't for.
import { SCENARIO_ACTIVE_STATES, type ScenarioIndex } from "@cleared/core";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import useSWR from "swr";
import { Link, useRouter } from "../../i18n/navigation.ts";
import { getParsed, newKey, postJson } from "../../lib/api.ts";
import { SandboxBadge } from "../SandboxBadge.tsx";

async function fetchIndex(path: string): Promise<ScenarioIndex> {
  return getParsed(path, (s) => s.ScenarioIndexSchema);
}

const isActive = (state: string): boolean => (SCENARIO_ACTIVE_STATES as readonly string[]).includes(state);

/** `showOpen = false` on the scenario page itself, where "Open the dispute scenario" would loop back. */
export function ScenarioEntry({ showOpen = true }: { showOpen?: boolean }) {
  const t = useTranslations("scenario");
  const router = useRouter();
  const reasonId = useId();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { data } = useSWR<ScenarioIndex, unknown>("/api/scenarios", fetchIndex, { revalidateOnFocus: true });
  if (data === undefined) return null;
  const latest = data.latest;
  const openLink =
    latest === null || !showOpen ? null : (
      <Link
        href={`/scenario/${latest.id}`}
        className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
      >
        {t("open")}
      </Link>
    );
  if (latest !== null && isActive(latest.state)) {
    return (
      <div className="flex flex-col gap-1" data-testid="scenario-entry">
        <p className="text-sm text-text-muted">{t("running")}</p>
        {openLink}
      </div>
    );
  }
  if (!data.available && data.reason !== "llm_cap") return openLink;

  async function run(): Promise<void> {
    key.current ??= newKey();
    setBusy(true);
    setFailed(false);
    const res = await postJson("/api/scenarios", {}, key.current);
    key.current = null;
    const body = res.body as {
      scenario?: { id: string };
      error?: { details?: { scenarioId?: string } };
    } | null;
    const id = body?.scenario?.id ?? body?.error?.details?.scenarioId;
    if ((res.status === 201 || res.status === 409) && id !== undefined) {
      router.push(`/scenario/${id}`);
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  const capped = data.reason === "llm_cap";
  return (
    <div className="flex w-full max-w-[480px] flex-col gap-2 self-start" data-testid="scenario-entry">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || capped}
        aria-busy={busy || undefined}
        aria-label={busy ? undefined : t("ctaName")}
        aria-describedby={capped ? reasonId : undefined}
        className="inline-flex min-h-12 w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border-[1.5px] border-dashed border-border-strong bg-status-sandbox-bg px-4 py-2 font-medium text-status-sandbox-fg disabled:bg-surface-sunken disabled:text-text-muted md:w-auto"
      >
        {busy ? <Loader2 aria-hidden="true" size={16} className="spin" /> : null}
        <span className="text-center">{busy ? t("busy") : t("cta")}</span>
        {" "}
        <SandboxBadge decorative />
      </button>
      <p className="text-sm text-text-muted">{t("ctaHint")}</p>
      {capped ? (
        <p id={reasonId} className="text-sm text-text-muted">
          {t("llmCap")}
        </p>
      ) : null}
      {failed ? <p className="text-sm text-danger">{t("startError")}</p> : null}
      {openLink}
    </div>
  );
}
