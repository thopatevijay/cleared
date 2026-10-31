"use client";
// The dispute's audit trail (dispute-review.md §6): its proposals, approvals, checks, PayPal calls (with
// debug_id), drafting outcomes and mirrored statuses, newest first, as `AuditRow`s. Read only.
import { useTranslations } from "next-intl";
import { Link } from "../../i18n/navigation.ts";
import type { AuditEntry } from "../../lib/dispute-view.ts";
import { AuditRow } from "../audit/AuditRow.tsx";
import { useUiLocale } from "./text.ts";

export function AuditTrail({ entries, timeZone }: { entries: readonly AuditEntry[]; timeZone: string }) {
  const t = useTranslations("disputes.audit");
  const locale = useUiLocale();
  return (
    <section aria-labelledby="trail-heading" className="flex flex-col gap-3" data-testid="audit-trail">
      <h2 id="trail-heading" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      {entries.length === 0 ? (
        <p className="text-text-muted">{t("empty")}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border">
          {entries.map((e) => (
            <AuditRow key={e.id} e={e} locale={locale} timeZone={timeZone} />
          ))}
        </ul>
      )}
      <Link
        href="/audit"
        className="inline-flex min-h-11 items-center self-start text-accent underline underline-offset-2"
      >
        {t("all")}
      </Link>
    </section>
  );
}
