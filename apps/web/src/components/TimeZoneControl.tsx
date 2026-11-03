"use client";
// Time zone control (components.md "Time zone control", M4-03): the workspace's IANA zone in the dashboard
// footer, editable. Save → PATCH /api/workspace { timezone }; every list re-fetches so dates re-render in
// the new zone without a reload.
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useRouter } from "../i18n/navigation.ts";
import { getJson, newKey, patchJson } from "../lib/api.ts";

interface WorkspaceData {
  readonly workspace: { readonly timezone: string };
}

function zones(current: string): string[] {
  const all = new Set([...Intl.supportedValuesOf("timeZone"), "UTC", current]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export function TimeZoneControl() {
  const t = useTranslations("dashboard.timeZone");
  const id = useId();
  const router = useRouter();
  const { mutate: revalidate } = useSWRConfig();
  const { data, mutate } = useSWR<WorkspaceData, unknown>("/api/workspace", (p: string) =>
    getJson(p).then((b) => b as WorkspaceData),
  );
  const current = data?.workspace.timezone;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const options = useMemo(() => (current === undefined ? [] : zones(current)), [current]);

  function close(): void {
    setOpen(false);
    setFailed(false);
    toggle.current?.focus();
  }

  async function save(): Promise<void> {
    if (current === undefined) return;
    setBusy(true);
    setFailed(false);
    const res = await patchJson("/api/workspace", { timezone: choice }, newKey());
    setBusy(false);
    if (res.status !== 200) {
      setFailed(true);
      return;
    }
    setSaved(choice);
    await mutate(res.body as WorkspaceData, { revalidate: false });
    close();
    // every list on the page re-reads the workspace zone (SWR), and server-rendered parts refresh
    void revalidate(() => true);
    router.refresh();
  }

  if (current === undefined) return <p className="min-h-11" data-testid="tz-control" />;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="tz-control"
      onKeyDown={(e: KeyboardEvent) => {
        if (open && e.key === "Escape") close();
      }}
    >
      <p className="flex flex-wrap items-center gap-x-3">
        <span>
          {t.rich("current", {
            zone: current,
            tz: (chunks) => (
              <span className="tabular" lang="en" translate="no" data-testid="tz-current">
                {chunks}
              </span>
            ),
          })}
        </span>
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-region`}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            setChoice(current);
            setSaved(null);
            setOpen(true);
            requestAnimationFrame(() => document.getElementById(`${id}-select`)?.focus());
          }}
          className="inline-flex min-h-11 items-center text-accent underline underline-offset-2"
          data-testid="tz-change"
        >
          {t("change")}
        </button>
      </p>
      <div id={`${id}-region`} hidden={!open} className="flex max-w-[360px] flex-col gap-2">
        <label htmlFor={`${id}-select`} className="font-medium text-text">
          {t("label")}
        </label>
        <select
          id={`${id}-select`}
          value={choice}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setChoice(e.target.value);
          }}
          className="min-h-11 w-full rounded-md border border-border-strong bg-surface px-3 text-text"
          lang="en"
          translate="no"
          data-testid="tz-select"
        >
          {options.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <p id={`${id}-hint`}>{t("hint")}</p>
        {failed ? (
          <p role="alert" className="text-danger" data-testid="tz-error">
            {t("error")}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 min-[321px]:flex-row">
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void save()}
            className="min-h-11 rounded-md bg-accent px-4 font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-70"
            data-testid="tz-save"
          >
            {busy ? t("saving") : t("save")}
          </button>
          <button
            type="button"
            onClick={close}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-4 font-medium text-accent"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
      <p aria-live="polite" className={saved === null ? "sr-only" : ""} data-testid="tz-saved">
        {saved === null ? "" : t("saved", { zone: saved })}
      </p>
    </div>
  );
}
