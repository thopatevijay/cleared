"use client";
// BL-01 6539398891 (owner decision 2026-11-04): a seller-only warning on the ApprovalCard when the draft's
// notes rely on scope lines the pack's check marks partial or missing. The lines stay in the notes (honest
// by default); this tells the seller the reply admits the gap and that an edit before approving changes it
// (the approval binds to the edited fingerprint). After a seller edit the lines are those the agent's draft
// relied on, so the copy asks the seller to check. Never sent to PayPal. Line text is model output: plain
// text, in English (`lang="en"`) whatever the UI language.
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { DraftGap } from "../../lib/dispute-view.ts";

export function ScopeGapWarning({ gaps, edited }: { gaps: readonly DraftGap[]; edited: boolean }) {
  const t = useTranslations("disputes.draft.gaps");
  const id = useId();
  if (gaps.length === 0) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex gap-3 rounded-md border border-status-held-fg/30 bg-status-held-bg p-3 text-status-held-fg"
      data-testid="scope-gap-warning"
    >
      <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-2">
        <h3 id={`${id}-title`} className="font-semibold">
          {t(edited ? "titleEdited" : "title")}
        </h3>
        <p>{t(edited ? "bodyEdited" : "body")}</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {gaps.map((g) => (
            <li key={g.lineId} className="break-words" data-testid="scope-gap">
              <span className="font-semibold">{t(`verdict.${g.verdict}`)}</span>{" "}
              <span lang="en">{g.requirement}</span>
            </li>
          ))}
        </ul>
        <p>{t("edit")}</p>
        <p className="text-sm">{t("private")}</p>
      </div>
    </section>
  );
}
