"use client";
// Audit filters (audit-log.md): Actor and Kind apply on change; the ID search applies on submit. At 375 px
// they collapse behind a 44 px "Filter" button, with chips naming the active filters; from 768 px they sit
// inline in one row.
import { SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

export const ACTORS = ["seller", "agent", "system", "sandbox"] as const;
export const KINDS = ["disputes", "tracking", "signin", "sandbox"] as const;
export interface AuditFilterValue {
  readonly actor: (typeof ACTORS)[number] | null;
  readonly kind: (typeof KINDS)[number] | null;
  readonly q: string;
}
export const NO_FILTERS: AuditFilterValue = { actor: null, kind: null, q: "" };
export const hasFilters = (f: AuditFilterValue): boolean => f.actor !== null || f.kind !== null || f.q !== "";
const Q_RE = /^[A-Za-z0-9_-]{2,64}$/;

export function AuditFilters({
  value,
  onChange,
}: {
  value: AuditFilterValue;
  onChange: (v: AuditFilterValue) => void;
}) {
  const t = useTranslations("auditLog");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value.q);
  const [invalid, setInvalid] = useState(false);
  const chips = [
    value.actor === null ? null : t(`actor.${value.actor}`),
    value.kind === null ? null : t(`filters.kinds.${value.kind}`),
    value.q === "" ? null : value.q,
  ].filter((c): c is string => c !== null);
  const select = "min-h-11 rounded-md border border-border-strong bg-surface px-3";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 md:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-form`}
          onClick={() => {
            setOpen((o) => !o);
          }}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border-strong px-4 font-medium"
        >
          <SlidersHorizontal aria-hidden="true" size={18} />
          {t("filters.toggle")}
        </button>
        {chips.length === 0 ? null : (
          <ul aria-label={t("filters.active")} className="flex flex-wrap gap-1">
            {chips.map((c) => (
              <li key={c} className="rounded-pill bg-surface-sunken px-2 py-0.5 text-sm">
                {c}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        id={`${id}-form`}
        role="search"
        aria-label={t("filters.legend")}
        className={`${open ? "flex" : "hidden"} flex-col gap-3 rounded-lg border border-border bg-surface p-3 md:flex md:flex-row md:flex-wrap md:items-end`}
        onSubmit={(e) => {
          e.preventDefault();
          const v = q.trim();
          if (v !== "" && !Q_RE.test(v)) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onChange({ ...value, q: v });
        }}
        data-testid="audit-filters"
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t("filters.actor")}</span>
          <select
            className={select}
            value={value.actor ?? ""}
            onChange={(e) => {
              onChange({ ...value, actor: (e.target.value || null) as AuditFilterValue["actor"] });
            }}
            data-testid="filter-actor"
          >
            <option value="">{t("filters.all")}</option>
            {ACTORS.map((a) => (
              <option key={a} value={a}>
                {t(`actor.${a}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t("filters.kind")}</span>
          <select
            className={select}
            value={value.kind ?? ""}
            onChange={(e) => {
              onChange({ ...value, kind: (e.target.value || null) as AuditFilterValue["kind"] });
            }}
            data-testid="filter-kind"
          >
            <option value="">{t("filters.all")}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`filters.kinds.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-medium">{t("filters.search")}</span>
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
            aria-describedby={`${id}-hint`}
            aria-invalid={invalid || undefined}
            className="min-h-11 rounded-md border border-border-strong bg-surface px-3 font-mono"
            data-testid="filter-q"
          />
          <span id={`${id}-hint`} className={`text-xs ${invalid ? "text-danger" : "text-text-muted"}`}>
            {invalid ? t("filters.invalid") : t("filters.searchHint")}
          </span>
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-md border border-border-strong px-4 font-medium text-accent"
        >
          {t("filters.apply")}
        </button>
      </form>
    </div>
  );
}
