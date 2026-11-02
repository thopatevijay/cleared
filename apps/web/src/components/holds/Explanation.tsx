"use client";
// The hold explanation (M3-02, hold.md "Detail" §2): the summary, "What PayPal is doing" and "What you can
// do" in English or Hindi, labelled "AI explanation" or "Standard explanation". The EN/HI toggle (default: the
// UI language) asks the server for a locale that has no explanation yet; the detail poll then brings it.
// Everything here is plain text: React escapes it, nothing is parsed as markup (the model's output is data).
import type { HoldExplanation, Locale } from "@cleared/core";
import { Bot, FileText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { isAppLocale } from "../../i18n/routing.ts";
import { newKey, postJson } from "../../lib/api.ts";

const LANGS: readonly Locale[] = ["en", "hi"];

function Toggle({ value, onChange }: { value: Locale; onChange: (l: Locale) => void }) {
  const t = useTranslations("holds.explanation");
  const tc = useTranslations("common");
  return (
    <div role="group" aria-label={t("language")} className="flex gap-2" data-testid="explanation-locale">
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === value}
          onClick={() => {
            onChange(l);
          }}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border px-3 text-sm ${
            l === value
              ? "border-accent bg-surface-sunken font-bold text-text"
              : "border-border text-accent hover:bg-surface-sunken"
          }`}
        >
          {tc(l === "en" ? "langEn" : "langHi")}
        </button>
      ))}
    </div>
  );
}

export function ExplanationBody({ e }: { e: HoldExplanation }) {
  const t = useTranslations("holds.explanation");
  const ai = e.origin === "ai";
  const Icon = ai ? Bot : FileText;
  return (
    <div className="flex flex-col gap-3" data-testid="explanation" data-origin={e.origin}>
      <p className="inline-flex items-center gap-1 self-start rounded-md bg-surface-sunken px-2 py-1 text-sm text-text-muted">
        <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
        <span>{ai ? t("ai") : t("standard")}</span>
      </p>
      <p className="text-lg" lang={e.locale} data-testid="explanation-summary">
        {e.summary}
      </p>
      <div className="flex flex-col gap-1">
        <h3 className="font-semibold">{t("doingTitle")}</h3>
        <p lang={e.locale}>{e.whatPayPalIsDoing}</p>
      </div>
      {e.whatYouCanDo.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold">{t("canDoTitle")}</h3>
          <ul className="list-disc pl-5" lang={e.locale}>
            {e.whatYouCanDo.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Asks once per (hold, locale) for a missing explanation; the poll picks up the result. */
function useRequest(holdId: string, locale: Locale, missing: boolean): boolean {
  const asked = useRef(new Set<string>());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const key = `${holdId}:${locale}`;
    if (!missing || asked.current.has(key)) return;
    asked.current.add(key);
    setFailed(false);
    void postJson(`/api/holds/${holdId}/explanation`, { locale }, newKey()).then((r) => {
      if (r.status !== 200 && r.status !== 202) setFailed(true);
    });
  }, [holdId, locale, missing]);
  return failed;
}

export function Explanation({
  holdId,
  explanations,
  released,
}: {
  holdId: string;
  explanations: readonly HoldExplanation[];
  released: boolean;
}) {
  const t = useTranslations("holds.explanation");
  const ui = useLocale();
  const [locale, setLocale] = useState<Locale>(isAppLocale(ui) ? ui : "en");
  const current = explanations.find((e) => e.locale === locale) ?? null;
  const failed = useRequest(holdId, locale, current === null && !released);
  return (
    <div className="flex flex-col gap-3">
      <Toggle value={locale} onChange={setLocale} />
      {current !== null ? (
        <ExplanationBody e={current} />
      ) : released ? null : (
        <p role="status" className="text-text-muted" data-testid="explanation-pending">
          {failed ? t("unavailable") : t("pending")}
        </p>
      )}
    </div>
  );
}
