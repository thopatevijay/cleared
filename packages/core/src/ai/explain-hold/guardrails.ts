// The `explain_hold@v1` output guardrails (M3-02): deterministic code checks over the model's answer, run by
// the harness after the schema (`[]` passes; a failure gets one repair, then the job falls back to the
// standard text). Each problem starts with its code:
// - `rule_id_mismatch`: `ruleId` must be the input rule's id
// - `foreign_number`: every number (ASCII or Devanagari digits) must appear in the input (the rule quotes)
// - `date_expression`: no calendar date or weekday at all: the only date is the `{estimated_release}` slot
// - `unknown_slot`: only the slots the input offers
// - `promise_word`: no promise ("guaranteed", "will release" without "estimated"), EN and HI lists both
// - `wrong_language`: Hindi output has Devanagari; English output has none
import type { Locale } from "../../accounts/workspace.ts";
import { EXPLAIN_SLOTS, type ExplainHoldInput, type ExplainHoldOutput } from "./schema.ts";

export const EXPLAIN_PROBLEMS = [
  "rule_id_mismatch",
  "foreign_number",
  "date_expression",
  "unknown_slot",
  "promise_word",
  "wrong_language",
] as const;
export type ExplainProblem = (typeof EXPLAIN_PROBLEMS)[number];

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const DEVANAGARI = /[ऀ-ॿ]/;

/** Devanagari digits as ASCII, so `३` and `3` are the same number. */
export function asciiDigits(text: string): string {
  return text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

/** Every number in `text` (`1,000.50` → `1000.50`). */
export function numbersIn(text: string): string[] {
  const found = asciiDigits(text).match(/\d+(?:[.,]\d+)*/g) ?? [];
  return found.map((n) => n.replace(/,/g, ""));
}

const EN_MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const HI_MONTHS =
  "जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|अक्तूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर";
const EN_DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const HI_DAYS = "सोमवार|मंगलवार|बुधवार|गुरुवार|बृहस्पतिवार|शुक्रवार|शनिवार|रविवार";

const DATE_PATTERNS: readonly RegExp[] = [
  // "3 Nov", "Nov 3", "3 नवंबर" (a month name next to a number)
  new RegExp(`\\d{1,4}(?:st|nd|rd|th)?\\s*(?:of\\s+)?(?:${EN_MONTHS})\\b`, "i"),
  new RegExp(`\\b(?:${EN_MONTHS})\\.?\\s*\\d{1,4}`, "i"),
  new RegExp(`\\d{1,4}\\s*(?:${HI_MONTHS})`),
  new RegExp(`(?:${HI_MONTHS})\\s*\\d{1,4}`),
  // full month names (not "may", the verb), weekdays, numeric dates
  /\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/i,
  new RegExp(`(?:${HI_MONTHS.replace("|मई", "")})`),
  new RegExp(`\\b(?:${EN_DAYS})\\b`, "i"),
  new RegExp(`(?:${HI_DAYS})`),
  /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/,
];

/** The first calendar date or weekday in `text`, or null. */
export function dateExpressionIn(text: string): string | null {
  const t = asciiDigits(text);
  for (const re of DATE_PATTERNS) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
}

/** Promise words, whatever the locale (Hindi answers can carry English words). */
const PROMISE_WORDS: readonly RegExp[] = [
  /\bguarantee(?:d|s)?\b/i,
  /\bpromise(?:d|s)?\b/i,
  /\bdefinitely\b/i,
  /\bcertainly\b/i,
  /\bfor sure\b/i,
  /गारंटी/,
  /पक्का|पक्की/,
  /निश्चित रूप से/,
  /वादा/,
  /(?:ज़रूर|जरूर)(?!त|ी|ि)/, // not ज़रूरत ("need") or ज़रूरी ("necessary")
];
/** A release stated as certain; allowed only in a sentence that also says it is estimated. */
const WILL_RELEASE: readonly RegExp[] = [
  /\bwill\s+(?:be\s+)?(?:releas|availabl|freed|paid|unlock)/i,
  /(?:रिलीज़|रिलीज|जारी|उपलब्ध|मुक्त)\s*(?:कर\s*)?(?:हो\s*|दिया\s*|दी\s*)?जाएग/,
  /(?:पैसा|राशि|रकम)[^।.!?]{0,40}मिल\s*जाएग/,
];
const ESTIMATED = /estimat|अनुमान/i;

const sentences = (text: string): string[] => text.split(/(?<=[.!?।])\s+|\n+/).filter((s) => s.trim() !== "");

function promiseProblems(text: string): string[] {
  const out: string[] = [];
  for (const re of PROMISE_WORDS) {
    const m = re.exec(text);
    if (m)
      out.push(`promise_word: "${m[0]}" promises an outcome; PayPal decides holds, so say what is estimated`);
  }
  for (const s of sentences(text))
    for (const re of WILL_RELEASE) {
      const m = re.exec(s);
      if (m && !ESTIMATED.test(s))
        out.push(
          `promise_word: "${m[0]}" states a release as certain; say it is estimated (or "estimated" / "अनुमानित")`,
        );
    }
  return out;
}

const fieldsOf = (out: ExplainHoldOutput): string[] => [
  out.summary,
  out.whatPayPalIsDoing,
  ...out.whatYouCanDo,
];

/** Every number the input may lend the answer: the rule's quotes and titles, and PayPal's reason. */
function allowedNumbers(input: ExplainHoldInput): Set<string> {
  const text = [input.paypal_reason, ...input.rule.sources.flatMap((s) => [s.title, s.quote])].join("\n");
  return new Set(numbersIn(text));
}

function slotProblems(text: string, input: ExplainHoldInput): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{([^{}]{0,40})\}/g)) {
    const name = m[1] ?? "";
    const known = (EXPLAIN_SLOTS as readonly string[]).includes(name);
    if (!known || !(input.slots as readonly string[]).includes(name))
      out.push(
        `unknown_slot: {${name}} is not a slot this hold has; use only ${input.slots.map((s) => `{${s}}`).join(", ")}`,
      );
  }
  return out;
}

function languageProblem(out: ExplainHoldOutput, locale: Locale): string | null {
  const devanagari = DEVANAGARI.test(out.summary);
  if (locale === "hi" && !devanagari) return "wrong_language: write the explanation in Hindi (Devanagari)";
  if (locale === "en" && devanagari) return "wrong_language: write the explanation in English";
  return null;
}

/** Every code check over the model's answer; `[]` passes. Each problem starts with its `ExplainProblem` code. */
export function explainHoldProblems(out: ExplainHoldOutput, input: ExplainHoldInput): string[] {
  const problems: string[] = [];
  if (out.ruleId !== input.rule.id)
    problems.push(`rule_id_mismatch: ruleId is "${out.ruleId}"; it must be "${input.rule.id}"`);
  const allowed = allowedNumbers(input);
  for (const field of fieldsOf(out)) {
    // NFC: a precomposed nukta letter (U+095B ज़) and ज + nukta compare equal
    const withoutSlots = field.normalize("NFC").replace(/\{[a-z_]{1,40}\}/g, " ");
    for (const n of numbersIn(withoutSlots))
      if (!allowed.has(n))
        problems.push(`foreign_number: ${n} is not in the data; never add a number, amount or date`);
    const date = dateExpressionIn(withoutSlots);
    if (date !== null)
      problems.push(
        `date_expression: "${date}" is a date; never write a date or weekday (use {estimated_release} if offered)`,
      );
    problems.push(...slotProblems(field, input), ...promiseProblems(withoutSlots));
  }
  const lang = languageProblem(out, input.locale);
  if (lang !== null) problems.push(lang);
  return [...new Set(problems)];
}

/** The first problem code in a failed run's reason (the harness joins the problems with "; "). */
export function explainProblemOf(reason: string): ExplainProblem | null {
  let best: { code: ExplainProblem; at: number } | null = null;
  for (const code of EXPLAIN_PROBLEMS) {
    const at = reason.indexOf(`${code}:`);
    if (at >= 0 && (best === null || at < best.at)) best = { code, at };
  }
  return best?.code ?? null;
}
