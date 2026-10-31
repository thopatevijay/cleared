// The pack's evidence (payment-detail.md §5), newest first: kind, the first line of a text item or the
// file type and size, when it was added (workspace time zone), the sha256 short form, the injection-flag
// badge and a download link for files. Excerpts are evidence data: plain text.
import type { PackEvidence } from "@cleared/core";
import { Download, ShieldAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { formatTime } from "../../lib/format.ts";
import { formatBytes } from "./intake-checks.ts";

const TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "application/pdf": "PDF",
};

function firstLine(excerpt: string | null): string {
  const line = (excerpt ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function EvidenceList({ items, timeZone }: { items: readonly PackEvidence[]; timeZone: string }) {
  const t = useTranslations("pack");
  const raw = useLocale();
  const locale = intlLocale(isAppLocale(raw) ? raw : "en");
  if (items.length === 0) return <p className="text-text-muted">{t("list.empty")}</p>;
  return (
    <ul className="flex flex-col" data-testid="evidence-list">
      {items.map((i) => {
        const time = formatTime(locale, i.createdAt, timeZone);
        const kind = t(`kind.${i.kind}`);
        const type = TYPE[i.mime ?? ""] ?? "";
        return (
          <li
            key={i.id}
            id={`evidence-${i.id}`}
            tabIndex={-1}
            className="flex flex-col gap-1 rounded-md border-b border-border py-3 last:border-b-0"
            data-testid="evidence-item"
            data-kind={i.kind}
          >
            <span className="font-medium first-letter:uppercase">{kind}</span>
            <span className="break-words">
              {i.fileUrl === null
                ? firstLine(i.excerpt)
                : t("list.file", { type, size: formatBytes(locale, i.size ?? 0) })}
            </span>
            {i.fileUrl === null ? (
              <span className="text-sm text-text-muted">{t("list.text", { count: i.textLength })}</span>
            ) : null}
            <span className="text-sm text-text-muted">
              <time dateTime={i.createdAt}>{t("list.added", { time })}</time>
            </span>
            <span className="font-mono text-xs text-text-muted" title={i.sha256}>
              {t("list.sha", { short: i.sha256.slice(0, 12) })}
            </span>
            {i.injectionFlagged ? (
              <span
                className="inline-flex items-start gap-1 self-start rounded-md bg-status-info-bg px-2 py-1 text-sm text-status-info-fg"
                data-testid="injection-flag"
              >
                <ShieldAlert aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                {t("list.injection")}
              </span>
            ) : null}
            {i.fileUrl !== null ? (
              <a
                href={i.fileUrl}
                download
                aria-label={t("list.downloadName", { kind, time })}
                className="inline-flex min-h-11 items-center gap-1 self-start text-accent underline underline-offset-2"
              >
                <Download aria-hidden="true" size={16} strokeWidth={1.75} />
                {t("list.download")}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
