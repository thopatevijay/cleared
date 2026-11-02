// `explain_hold@v1` (M3-02, ADR 0009): the model's answer, the grounded input it is written from, and the
// explanation Cleared stores and shows. The input is also the harness cache key, so it carries only what is
// the same for every hold under one rule: the rule row, PayPal's reason, the locale and which slots exist.
// The hold's own amount and dates reach the model as slots (`{amount}`, `{opened_at}`, `{estimated_release}`)
// that code fills in (render.ts): a cached answer never carries another hold's numbers, and the model never
// writes a date. Strict structured outputs need every property required.
import { z } from "zod";
import { LOCALES, type Locale } from "../../accounts/workspace.ts";
import { HOLD_TYPES, type HoldType } from "../../holds/rules.ts";

export const EXPLAIN_HOLD_SCHEMA_VERSION = "hold_explanation@v1";
export const EXPLAIN_MAX_ACTIONS = 3;

/** The slots code fills in; the model may write them, never their values. */
export const EXPLAIN_SLOTS = ["amount", "opened_at", "estimated_release"] as const;
export type ExplainSlot = (typeof EXPLAIN_SLOTS)[number];

/**
 * The bounds are loose on purpose: a wrong rule id, a foreign number or a promise word fails the code
 * guardrails (one repair with a precise message, then the fallback), not the schema.
 */
export const ExplainHoldOutputSchema = z.object({
  summary: z.string().min(1).max(600),
  whatPayPalIsDoing: z.string().min(1).max(900),
  whatYouCanDo: z.array(z.string().min(1).max(300)).max(EXPLAIN_MAX_ACTIONS),
  ruleId: z.string().min(1).max(80),
});
export type ExplainHoldOutput = z.infer<typeof ExplainHoldOutputSchema>;

/** The model's input and the run's cache key: (rule row, reason, locale, prompt version via the harness). */
export type ExplainHoldInput = {
  readonly rule: {
    readonly id: string;
    readonly version: number;
    /** each source's title and verbatim quote (the first is the one shown by default) */
    readonly sources: readonly { readonly title: string; readonly quote: string }[];
  };
  /** capture `status_details.reason`, verbatim */
  readonly paypal_reason: string;
  readonly hold_type: HoldType;
  readonly locale: Locale;
  /** the slots this hold has (`estimated_release` only when the rule gives a timeline) */
  readonly slots: readonly ExplainSlot[];
};

export const EXPLANATION_ORIGINS = ["ai", "standard"] as const;
export type ExplanationOrigin = (typeof EXPLANATION_ORIGINS)[number];

const when = z.iso.datetime({ offset: true });

/** What `explanations.text` holds (JSON) and the API returns: plain text only, rendered as text. */
export const StoredExplanationSchema = z.object({
  /** "AI explanation" vs "standard explanation" in the UI */
  origin: z.enum(EXPLANATION_ORIGINS),
  locale: z.enum(LOCALES),
  ruleId: z.string().min(1),
  summary: z.string().min(1),
  whatPayPalIsDoing: z.string().min(1),
  whatYouCanDo: z.array(z.string().min(1)).max(EXPLAIN_MAX_ACTIONS),
  /** inserted by code from the rule row, never by the model */
  estimate: z.object({ at: when, label: z.literal("estimated") }).nullable(),
  source: z.object({ url: z.url(), title: z.string().min(1) }),
  /** `explain_hold@v1`, or `fallback@v1` for the standard text */
  promptVersion: z.string().min(1),
});
export type StoredExplanation = z.infer<typeof StoredExplanationSchema>;

/** One locale's explanation of a hold, as `GET /api/holds/:id` returns it. */
export const HoldExplanationSchema = StoredExplanationSchema.extend({
  id: z.uuid(),
  createdAt: when,
});
export type HoldExplanation = z.infer<typeof HoldExplanationSchema>;

export const isHoldType = (t: string): t is HoldType => (HOLD_TYPES as readonly string[]).includes(t);
