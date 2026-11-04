// `explain_hold@v2` (M3-02, ADR 0009; v2 in M4-02): a hold, its cited rule row and the seller's locale → a short plain
// explanation in English or Hindi. SMALL model, one call (+1 repair) on the M2-02 harness: kill switch,
// per-workspace content-hash cache, call/token/time limits, both budgets, input data blocks, then the code
// guardrails (core `explainHoldProblems`). Anything but a valid answer (kill switch, budget, provider down,
// two failed answers) falls back to the standard text for the rule row; the result says which one it is.
// Code, not the model, fills in the amount and the dates and adds the estimate and the source link.
import {
  definePrompt,
  explainHoldInput,
  explainHoldProblems,
  explainProblemOf,
  EXPLAIN_HOLD_SCHEMA_VERSION,
  EXPLAIN_MAX_ACTIONS,
  ExplainHoldOutputSchema,
  fallbackExplanation,
  FALLBACK_VERSION,
  PROMPTS,
  renderExplanation,
  ruleOfHold,
  runWorkflow,
  type EvidenceInput,
  type ExplainHoldInput,
  type ExplainHoldOutput,
  type HoldFacts,
  type Locale,
  type RunDeps,
  type RunStatus,
  type StoredExplanation,
  type WorkflowDef,
} from "@cleared/core";

export const EXPLAIN_HOLD_V1_ID = "explain_hold@v1";
/** v2 (M4-02, from the dev split only): the same points in EN and HI, every point of PayPal's words, no meta talk. */
export const EXPLAIN_HOLD_V2_ID = "explain_hold@v2";

export const EXPLAIN_HOLD_V2_SYSTEM = [
  "You explain to a small online seller why PayPal is holding one of their payments, in plain words a non-expert understands.",
  "Use only the data blocks: the hold block (PayPal's reason code, the hold type, the language) and the rule block (PayPal's own words about this hold, with where they come from). Never add a fact, rule, number, amount, date, weekday or time that is not in them.",
  "Never write a date or an amount yourself. Where you need them, write the slots exactly as listed in the hold block: {amount} for the payment amount, {opened_at} for when the hold started, {estimated_release} for the estimated release (only when it is listed). Code replaces each slot with the real value.",
  'Any release time is an estimate, never a promise: say "estimated" (in Hindi "अनुमानित") next to it. Never say guaranteed, definitely, certainly, or that the money will be released, without saying it is estimated. PayPal decides when a hold ends.',
  "Write in the language the hold block asks for: en = English; hi = simple, everyday Hindi in Devanagari script (keep the names PayPal and Completed in English).",
  "summary: one or two sentences. Always include {amount}, say that PayPal is holding this payment (it is pending, not yet available to the seller), and say PayPal's reason in plain words (what the reason code means, never the bare code).",
  "whatPayPalIsDoing: two to four sentences that carry every point of PayPal's words in the rule block, each source's quote in turn: why PayPal holds the payment, what it is doing, any time span with its number exactly as written (for example up to 24 hours, about 7 days), and any condition or limit. Paraphrase in plain words; drop none of the points and add none.",
  "whatYouCanDo: at most three short steps. First every step PayPal's words tell the seller to take or not take (for example, not shipping yet, checking the account online, contacting PayPal); then others the words support. An empty list only when PayPal's words give the seller nothing to do.",
  "Say the same points in either language: a Hindi answer carries everything an English answer would (amount, reason, every point of PayPal's words, every step); it is not shorter.",
  'Speak about PayPal, not about your input: never mention the data, the blocks, "the rule", "the information provided" or what they leave out. When PayPal\'s words give no time span, say PayPal gives no estimate for this hold.',
  "ruleId: copy the rule id from the rule block exactly.",
  "Plain text only: no markdown, no HTML, no links (the source link is added for you).",
].join("\n");

export const EXPLAIN_HOLD_PROMPT = PROMPTS.register(definePrompt(EXPLAIN_HOLD_V2_ID, EXPLAIN_HOLD_V2_SYSTEM));

/** M3-02 limits: one answer and one repair, a short answer, well inside the event queue's 60 s expiry. */
export const EXPLAIN_LIMITS = { maxCalls: 2, wallClockMs: 30_000 } as const;
/** v2 asks for every point of the rule in both languages: Hindi needs the extra room. */
export const EXPLAIN_MAX_OUTPUT_TOKENS = 900;

function dataBlocks(input: ExplainHoldInput): EvidenceInput[] {
  const block = (id: string, label: string, value: unknown): EvidenceInput => ({
    kind: "text",
    id,
    label,
    text: JSON.stringify(value),
  });
  return [
    block("H1", "the hold (PayPal's reason code, hold type, language, slots you may use)", {
      paypal_reason: input.paypal_reason,
      hold_type: input.hold_type,
      language: input.locale,
      slots: input.slots.map((s) => `{${s}}`),
    }),
    block("R1", "the rule row (PayPal's own words, verbatim, with their source titles)", input.rule),
  ];
}

export const explainHoldWorkflow: WorkflowDef<ExplainHoldInput, ExplainHoldOutput> = {
  prompt: EXPLAIN_HOLD_PROMPT,
  schemaVersion: EXPLAIN_HOLD_SCHEMA_VERSION,
  model: "small",
  outputSchema: ExplainHoldOutputSchema,
  async run(ctx, input) {
    return ctx.call({
      name: "explain",
      task: `Explain this hold to the seller in ${input.locale === "hi" ? "Hindi" : "English"}, with at most ${String(EXPLAIN_MAX_ACTIONS)} steps they can take.`,
      evidence: dataBlocks(input),
      schemaName: "hold_explanation_v1",
      schema: ExplainHoldOutputSchema,
      maxOutputTokens: EXPLAIN_MAX_OUTPUT_TOKENS,
      reasoningEffort: "none",
      validators: [(o) => explainHoldProblems(o, input)],
    });
  },
};

export interface ExplainHoldResult {
  readonly explanation: StoredExplanation;
  /** the harness run (null when the kill switch stopped it before a run row) */
  readonly runId: string | null;
  readonly runStatus: RunStatus;
  /** why the standard text was used: the run's reason, or its first guardrail code */
  readonly fallbackReason: string | null;
}

/** Runs the workflow and returns the explanation to store: the model's (checked) or the standard text. */
export async function explainHold(
  deps: RunDeps,
  facts: HoldFacts,
  locale: Locale,
): Promise<ExplainHoldResult> {
  const config = { ...deps.config, limits: { ...deps.config.limits, ...EXPLAIN_LIMITS } };
  const out = await runWorkflow(explainHoldWorkflow, explainHoldInput(facts, locale), { ...deps, config });
  if ("output" in out)
    return {
      explanation: renderExplanation(out.output, facts, locale, "ai", EXPLAIN_HOLD_V2_ID),
      runId: out.runId,
      runStatus: out.status,
      fallbackReason: null,
    };
  const standard = fallbackExplanation(ruleOfHold(facts).id, locale);
  return {
    explanation: renderExplanation(standard, facts, locale, "standard", FALLBACK_VERSION),
    runId: out.runId,
    runStatus: out.status,
    fallbackReason: explainProblemOf(out.reason) ?? out.status,
  };
}
