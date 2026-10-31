// One scope line and its verdict (payment-detail.md §3): the line in the seller's words, the verdict as
// icon + word, the reason when it is unverifiable, the model's rationale (plain text) and the citations:
// where the line was agreed, and what shows it delivered (or missing).
import type { LineNote, PackVerdict } from "@cleared/core";
import { useTranslations } from "next-intl";
import { Citation } from "./Citation.tsx";
import { VerdictBadge } from "./VerdictBadge.tsx";

const NOTE_KEY: Readonly<Record<LineNote, "noCitation" | "imageOnly" | "noScopeQuote" | "model">> = {
  no_valid_citation: "noCitation",
  image_only_support: "imageOnly",
  no_scope_quote: "noScopeQuote",
  model_unverifiable: "model",
};

export function VerdictRow({
  v,
  kindOf,
  previous,
}: {
  v: PackVerdict;
  /** the evidence kind of a cited item, as words ("client chat") */
  kindOf: (evidenceItemId: string) => string;
  previous: boolean;
}) {
  const t = useTranslations("pack");
  const count = v.citations.length + (v.lineCitation === null ? 0 : 1);
  const name = t("verdictName", { line: v.line, verdict: t(`verdict.${v.verdict}`), count });
  return (
    <li
      aria-label={name}
      className={`flex flex-col gap-3 border-b border-border py-4 last:border-b-0 md:grid md:grid-cols-2 md:gap-6 ${previous ? "text-text-muted" : ""}`}
      data-testid="verdict-row"
      data-verdict={v.verdict}
      data-line-id={v.lineId}
    >
      <div className="flex flex-col gap-2">
        <p className="font-medium">{v.line}</p>
        {v.lineCitation !== null ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-text-muted">{t("agreedIn")}</p>
            <Citation c={v.lineCitation} from={kindOf(v.lineCitation.evidenceItemId)} />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-2">
        <VerdictBadge verdict={v.verdict} />
        {v.verdict === "unverifiable" && v.note !== null ? (
          <p className="text-sm" data-testid="unverifiable-reason">
            {t(`unverifiable.${NOTE_KEY[v.note]}`)}
          </p>
        ) : null}
        {v.rationale !== "" ? (
          <p className="text-sm break-words whitespace-pre-wrap" data-testid="rationale">
            {t("why", { rationale: v.rationale })}
          </p>
        ) : null}
        {v.citations.length > 0 ? (
          <div className="flex w-full flex-col gap-2">
            <p className="text-sm text-text-muted">{t("shownBy")}</p>
            {v.citations.map((c, i) => (
              <Citation key={`${c.evidenceItemId}-${String(i)}`} c={c} from={kindOf(c.evidenceItemId)} />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}
