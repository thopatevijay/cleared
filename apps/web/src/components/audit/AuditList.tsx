"use client";
// The workspace audit log (audit-log.md): newest first, grouped by day in the workspace time zone, 50 per
// page with "Load older". SWR re-reads the newest page every 5 s; new entries appear at the top and are
// announced politely, at most once per poll. A failed "Load older" keeps the loaded rows (partial state).
import { ScrollText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ApiError, getJson } from "../../lib/api.ts";
import { AuditPageSchema, type AuditEntry, type AuditPageData } from "../../lib/dispute-view.ts";
import { dayKey, formatDay } from "../../lib/format.ts";
import { ErrorPanel } from "../ErrorPanel.tsx";
import { useUiLocale } from "../disputes/text.ts";
import { AuditFilters, hasFilters, NO_FILTERS, type AuditFilterValue } from "./AuditFilters.tsx";
import { AuditRow } from "./AuditRow.tsx";
import { useAuditText } from "./text.ts";

export const AUDIT_POLL_MS = 5_000;

export function auditPath(f: AuditFilterValue, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.actor !== null) p.set("actor", f.actor);
  if (f.kind !== null) p.set("kind", f.kind);
  if (f.q !== "") p.set("q", f.q);
  if (cursor !== undefined) p.set("cursor", cursor);
  const s = p.toString();
  return s === "" ? "/api/audit" : `/api/audit?${s}`;
}

async function fetchPage(path: string): Promise<AuditPageData> {
  return AuditPageSchema.parse(await getJson(path));
}

function useOlder(filters: AuditFilterValue) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    setRows([]);
    setNext(undefined);
    setError(null);
  }, [filters]);
  async function load(cursor: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const page = await fetchPage(auditPath(filters, cursor));
      setRows((r) => [...r, ...page.items]);
      setNext(page.next);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, null));
    }
    setBusy(false);
  }
  return { rows, next, busy, error, load };
}

function useArrivalAnnouncement(items: readonly AuditEntry[] | undefined, filters: AuditFilterValue): string {
  const text = useAuditText();
  const t = useTranslations("auditLog");
  const seen = useRef<Set<string> | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    seen.current = null;
  }, [filters]);
  useEffect(() => {
    if (items === undefined) return;
    const prev = seen.current;
    seen.current = new Set([...(prev ?? []), ...items.map((i) => i.id)]);
    if (prev === null) return;
    const fresh = items.filter((i) => !prev.has(i.id));
    const first = fresh[0];
    if (first === undefined) return;
    setMsg(
      fresh.length === 1 ? t("newOne", { action: text.action(first) }) : t("newMany", { n: fresh.length }),
    );
  }, [items, t, text]);
  return msg;
}

function Groups({ rows, timeZone }: { rows: readonly AuditEntry[]; timeZone: string }) {
  const locale = useUiLocale();
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: AuditEntry[] }[] = [];
    for (const r of rows) {
      const key = dayKey(r.at, timeZone);
      const g = out.at(-1);
      if (g?.key === key) g.rows.push(r);
      else out.push({ key, label: formatDay(locale, r.at, timeZone), rows: [r] });
    }
    return out;
  }, [rows, timeZone, locale]);
  return (
    <div className="flex flex-col gap-5" data-testid="audit-list">
      {groups.map((g) => (
        <section
          key={g.key}
          aria-labelledby={`day-${g.key}`}
          className="flex flex-col gap-2"
          data-testid="audit-day"
        >
          <h2 id={`day-${g.key}`} className="text-lg font-semibold">
            {g.label}
          </h2>
          <ul className="overflow-hidden rounded-lg border border-border">
            {g.rows.map((e) => (
              <AuditRow
                key={e.id}
                e={e}
                locale={locale}
                timeZone={timeZone}
                disputeHref={(id) => `/disputes/${id}`}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Loading() {
  const t = useTranslations("auditLog");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => {
      setSlow(true);
    }, 3_000);
    return () => {
      clearTimeout(id);
    };
  }, []);
  return (
    <div aria-busy="true" data-testid="loading" className="flex flex-col gap-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} aria-hidden="true" className="skeleton-pulse block h-14 rounded-md" />
      ))}
      <p role="status" className="text-text-muted">
        {slow ? t("loading") : ""}
      </p>
    </div>
  );
}

export function AuditList() {
  const t = useTranslations("auditLog");
  const tp = useTranslations("audit");
  const [filters, setFilters] = useState<AuditFilterValue>(NO_FILTERS);
  const [formKey, setFormKey] = useState(0);
  const { data, error, isValidating, mutate } = useSWR<AuditPageData, unknown>(
    auditPath(filters),
    fetchPage,
    {
      refreshInterval: AUDIT_POLL_MS,
      refreshWhenHidden: false,
      keepPreviousData: false,
    },
  );
  const older = useOlder(filters);
  const announcement = useArrivalAnnouncement(data?.items, filters);
  const rows = useMemo(() => {
    const ids = new Set<string>();
    return [...(data?.items ?? []), ...older.rows].filter((r) =>
      ids.has(r.id) ? false : (ids.add(r.id), true),
    );
  }, [data, older.rows]);
  const next = older.next === undefined ? (data?.next ?? null) : older.next;
  const clear = () => {
    setFilters(NO_FILTERS);
    setFormKey((k) => k + 1);
  };
  let body;
  if (data === undefined && error === undefined) body = <Loading />;
  else if (data === undefined)
    body = (
      <ErrorPanel
        title={t("errorTitle")}
        body={t("errorBody")}
        reference={error instanceof ApiError ? error.correlationId : null}
        busy={isValidating}
        onRetry={() => void mutate()}
      />
    );
  else if (rows.length === 0 && hasFilters(filters))
    body = (
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
        data-testid="filtered-empty"
      >
        <p>{t("filters.noMatch")}</p>
        <button
          type="button"
          onClick={clear}
          className="min-h-11 rounded-md border border-border-strong px-4 font-medium text-accent"
        >
          {t("filters.clear")}
        </button>
      </div>
    );
  else if (rows.length === 0)
    body = (
      <div
        className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6"
        data-testid="empty-state"
      >
        <ScrollText aria-hidden="true" size={32} strokeWidth={1.75} className="text-text-muted" />
        <p>{tp("empty")}</p>
      </div>
    );
  else
    body = (
      <>
        <Groups rows={rows} timeZone={data.workspace.timezone} />
        {older.error === null ? null : (
          <div className="flex flex-col gap-2" data-testid="older-error">
            <ErrorPanel
              title={t("olderError")}
              reference={older.error.correlationId}
              busy={older.busy}
              onRetry={() => {
                if (next !== null) void older.load(next);
              }}
            />
          </div>
        )}
        {next === null ? (
          <p className="text-sm text-text-muted">{t("end")}</p>
        ) : older.error === null ? (
          <button
            type="button"
            onClick={() => void older.load(next)}
            disabled={older.busy}
            aria-busy={older.busy || undefined}
            className="min-h-11 self-start rounded-md border border-border-strong px-4 font-medium text-accent"
            data-testid="load-older"
          >
            {older.busy ? t("loadingOlder") : t("loadOlder")}
          </button>
        ) : null}
      </>
    );
  return (
    <div className="flex flex-col gap-4">
      <AuditFilters key={formKey} value={filters} onChange={setFilters} />
      {body}
      <p aria-live="polite" className="sr-only" data-testid="audit-live">
        {announcement}
      </p>
    </div>
  );
}
