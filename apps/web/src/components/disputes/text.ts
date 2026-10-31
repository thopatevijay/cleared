// Seller-facing words for PayPal's dispute enums and Cleared's refusal codes (dispute-review.md). Unknown
// values fall back to PayPal's own string (never an invented label); the enum itself is shown beside.
import { useLocale, useTranslations } from "next-intl";
import { intlLocale, isAppLocale } from "../../i18n/routing.ts";
import { isPaypalCoveredPayout, type Outcome } from "../../lib/dispute-view.ts";

export function useUiLocale(): string {
  const raw = useLocale();
  return intlLocale(isAppLocale(raw) ? raw : "en");
}

export function useDisputeText() {
  const t = useTranslations("disputes");
  return {
    reason: (r: string | null): string =>
      r === null ? t("reason.unknown") : t.has(`reason.${r}`) ? t(`reason.${r}`) : r,
    link: (rel: string): string => (t.has(`link.${rel}`) ? t(`link.${rel}`) : t("link.other", { rel })),
    /** a refusal or failure code (`DEADLINE_PASSED`…), localised with its next step */
    refusal: (code: string): string =>
      t.has(`refusal.${code}`) ? t(`refusal.${code}`) : t("refusal.other", { code }),
    outcome: (o: Outcome): string =>
      isPaypalCoveredPayout(o)
        ? t("outcome.payout")
        : t("outcome.other", {
            words: t.has(`outcome.words.${o.outcome_code}`)
              ? t(`outcome.words.${o.outcome_code}`)
              : t("outcome.words.other"),
            code: o.outcome_code,
          }),
    kind: (k: string): string => (t.has(`draft.kind.${k}`) ? t(`draft.kind.${k}`) : k),
  };
}

/** The refusal code in an ADR 0003 error body (`error.details.refusal`), else the snake-case code. */
export function refusalOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const e = (body as { error?: { code?: unknown; details?: { refusal?: unknown } } }).error;
  if (typeof e?.details?.refusal === "string") return e.details.refusal;
  return typeof e?.code === "string" ? e.code.toUpperCase() : null;
}
