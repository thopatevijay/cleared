// From a checked answer (the model's or the standard text) to the explanation Cleared stores: code fills the
// slots with this hold's amount and dates, and adds the estimate and the source link from the rule row. The
// model never writes a value of its own. Plain text in, plain text out (the UI renders it as text).
import type { Locale } from "../../accounts/workspace.ts";
import { holdRule, ruleForReason, ESTIMATE_LABEL, type HoldRule } from "../../holds/rules.ts";
import { formatDateTime } from "../../format/datetime.ts";
import { formatMoney } from "../../format/money.ts";
import type { Instant } from "../../time.ts";
import {
  type ExplainHoldInput,
  type ExplainHoldOutput,
  type ExplainSlot,
  type ExplanationOrigin,
  type StoredExplanation,
} from "./schema.ts";

/** The hold as the explainer sees it (from the `holds` row and its payment). */
export interface HoldFacts {
  readonly ruleId: string;
  readonly reason: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly openedAt: Instant;
  readonly estimatedReleaseAt: Instant | null;
  readonly timeZone: string;
}

/** The row behind a hold: its `estimate_source`, or the row for its reason when that id is unknown. */
export function ruleOfHold(f: Pick<HoldFacts, "ruleId" | "reason">): HoldRule {
  return holdRule(f.ruleId) ?? ruleForReason(f.reason);
}

/** The grounded input (and cache key): identical for every hold under one rule, reason and locale. */
export function explainHoldInput(f: HoldFacts, locale: Locale): ExplainHoldInput {
  const rule = ruleOfHold(f);
  const slots: ExplainSlot[] = ["amount", "opened_at"];
  if (f.estimatedReleaseAt !== null) slots.push("estimated_release");
  return {
    rule: {
      id: rule.id,
      version: rule.version,
      sources: rule.sources.map((s) => ({ title: s.title, quote: s.quote })),
    },
    paypal_reason: f.reason,
    hold_type: rule.type,
    locale,
    slots,
  };
}

/** The UI's Intl locales (apps/web `intlLocale`): Hindi keeps Latin digits. */
const INTL_LOCALE: Readonly<Record<Locale, string>> = { en: "en-IN", hi: "hi-IN-u-nu-latn" };

/**
 * The slot values for this hold, with the UI's own formatters (BL-01 6601578724, M4-02): the date in the
 * seller's zone with its name (Hindi on the 24-hour clock, never a Latin "pm" inside Devanagari) and the
 * amount with its ISO code ("USD 64.00": the currency is never guessed into a symbol).
 */
export function slotValues(f: HoldFacts, locale: Locale): Readonly<Record<ExplainSlot, string>> {
  const intl = INTL_LOCALE[locale];
  return {
    amount: formatMoney(f.amount.value, f.amount.currency, intl, "code"),
    opened_at: formatDateTime(f.openedAt, f.timeZone, intl),
    estimated_release: f.estimatedReleaseAt === null ? "" : formatDateTime(f.estimatedReleaseAt, f.timeZone, intl),
  };
}

export function fillSlots(text: string, values: Readonly<Record<ExplainSlot, string>>): string {
  return text.replace(/\{(amount|opened_at|estimated_release)\}/g, (_, name: ExplainSlot) => values[name]);
}

export function renderExplanation(
  out: ExplainHoldOutput,
  f: HoldFacts,
  locale: Locale,
  origin: ExplanationOrigin,
  promptVersion: string,
): StoredExplanation {
  const rule = ruleOfHold(f);
  const values = slotValues(f, locale);
  const fill = (s: string): string => fillSlots(s, values);
  const source = rule.sources[0];
  return {
    origin,
    locale,
    ruleId: rule.id,
    summary: fill(out.summary),
    whatPayPalIsDoing: fill(out.whatPayPalIsDoing),
    whatYouCanDo: out.whatYouCanDo.map(fill),
    estimate: f.estimatedReleaseAt === null ? null : { at: f.estimatedReleaseAt, label: ESTIMATE_LABEL },
    source: { url: source.url, title: source.title },
    promptVersion,
  };
}
