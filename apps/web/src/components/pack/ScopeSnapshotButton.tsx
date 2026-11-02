"use client";
// The proof pack's scope snapshot (M3-07, ADR 0018): ask the worker for a fixed PDF of the agreed scope (and
// the client's acknowledgement, if any), and download the newest one. The file is served as an attachment by
// GET /api/packs/:packId/scope-snapshot; it appears in Evidence as a `scope_snapshot` item once rendered.
import { FileDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { postJson } from "../../lib/api.ts";

const REFRESH_MS = 3_000;
const REFRESH_TRIES = 10; // ~30 s; an unchanged pack renders nothing new (the job is idempotent)
const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 font-medium disabled:opacity-60";

type Status = "idle" | "busy" | "queued" | "failed";

export function ScopeSnapshotPanel({
  packId,
  hasScope,
  snapshots,
  onQueued,
}: {
  packId: string;
  hasScope: boolean;
  /** how many `scope_snapshot` items the pack has */
  snapshots: number;
  /** reloads the pack view */
  onQueued: () => void;
}) {
  const t = useTranslations("pack.snapshot");
  const [status, setStatus] = useState<Status>("idle");
  const [reference, setReference] = useState<string | null>(null);
  const before = useRef(snapshots);
  const reload = useRef(onQueued); // the parent passes a new function each render
  useEffect(() => {
    reload.current = onQueued;
  }, [onQueued]);
  const path = `/api/packs/${packId}/scope-snapshot`;
  // While a render is queued, reload the pack until the new item shows up (or give up quietly).
  useEffect(() => {
    if (status !== "queued") return;
    if (snapshots > before.current) {
      setStatus("idle");
      return;
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      reload.current();
      if (tries >= REFRESH_TRIES) {
        clearInterval(timer);
        setStatus("idle");
      }
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [status, snapshots]);
  const create = async () => {
    setStatus("busy");
    before.current = snapshots;
    const r = await postJson(path, {}, crypto.randomUUID());
    if (r.status === 202) {
      setStatus("queued");
      return;
    }
    setReference(r.correlationId);
    setStatus("failed");
  };
  return (
    <section aria-labelledby="snapshot-heading" className="flex flex-col gap-3" data-testid="snapshot-panel">
      <h2 id="snapshot-heading" className="text-xl font-semibold">
        {t("title")}
      </h2>
      <p className="text-text-muted">{t("intro")}</p>
      {hasScope ? null : <p className="text-text-muted">{t("noScope")}</p>}
      <div className="flex flex-col gap-2 md:flex-row">
        <button
          type="button"
          className={BUTTON}
          disabled={!hasScope || status === "busy"}
          onClick={() => void create()}
        >
          {status === "busy" ? t("creating") : t("create")}
        </button>
        {snapshots > 0 ? (
          <a href={path} download className={`${BUTTON} gap-2`} data-testid="snapshot-download">
            <FileDown aria-hidden="true" size={18} strokeWidth={1.75} />
            {t("download")}
          </a>
        ) : null}
      </div>
      <p aria-live="polite" className="text-sm text-text-muted">
        {status === "queued" ? t("queued") : ""}
      </p>
      {status === "failed" ? (
        <p role="alert" className="text-sm text-danger">
          {t("failed", { reference: reference ?? "-" })}
        </p>
      ) : null}
    </section>
  );
}
