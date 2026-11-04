// LLM-as-judge (M4-02), used for one question only: does a hold explanation convey a fact? String checks
// decide the rule id, the language and the forbidden claims; whether "the review normally takes up to 3
// business days" is conveyed by a paraphrase (in English or Hindi) is what code cannot decide. The judge runs
// on the LARGE model (the explainer runs on SMALL), through the same harness as every workflow (limits,
// worst-case reservation, data blocks): the explanation is data, never instructions. Its prompt id and model
// are recorded in the report.
import { definePrompt, type JsonValue, type WorkflowDef } from "@cleared/core";
import { z } from "zod";

// v2 (2026-11-04, after the first live run on the test split): judge the fact, not who a statement credits
// it to ("the Holds panel says …"), and read PayPal's codes as the plain words the explainer is told to use.
// The v1 judge marked "normally takes up to 3 business days" as not conveyed for lacking "the Holds panel".
// Both runs are in the PR; the v1 numbers are not hidden.
export const JUDGE_PROMPT = definePrompt(
  "eval_judge@v2",
  [
    "You grade one explanation that a seller app showed to a seller about a PayPal payment hold.",
    "For each numbered statement in the statements block, decide whether the explanation conveys it: the explanation says it, or says something with the same meaning, in any language (the explanation may be in Hindi while the statement is in English).",
    "conveyed = true when a reader of the explanation alone would learn the statement's meaning. Plain words for a technical term count: a payment PayPal is holding (on hold, held, not yet available) is a pending payment; naming the payment's amount conveys what the amount is.",
    "PayPal's status codes count when the explanation gives their meaning in plain words: PENDING = the payment is held or pending; OTHER = PayPal gives no specific reason; BUYER_COMPLAINT = the buyer opened a complaint or dispute; PENDING_REVIEW = PayPal is reviewing the payment.",
    "Judge the fact, not its attribution: a statement that credits a fact to a source (\"the Holds panel says\", \"the rule says\", \"the capture lists\") is conveyed when the explanation states the fact itself.",
    "conveyed = false when the statement's point is absent, when only a weaker or different claim is made (\"may be released\" does not convey \"is guaranteed to be released\"), or when the explanation contradicts it.",
    "Judge only the explanation text. Do not use your own knowledge of PayPal, and do not judge whether the statement is true.",
    "note: one short sentence quoting or paraphrasing the part of the explanation you relied on, or saying it is absent.",
  ].join("\n"),
);

export const JUDGE_SCHEMA_VERSION = "judge@v1";
export const JUDGE_MAX_OUTPUT_TOKENS = 1_200;

export const JudgeOutputSchema = z.object({
  verdicts: z
    .array(z.object({ id: z.string().regex(/^S\d{1,2}$/), conveyed: z.boolean(), note: z.string().max(300) }))
    .min(1)
    .max(12),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export type JudgeInput = {
  readonly [key: string]: JsonValue;
  readonly explanation: string;
  readonly statements: readonly { readonly id: string; readonly text: string }[];
};

function judgeProblems(out: JudgeOutput, input: JudgeInput): string[] {
  const want = input.statements.map((s) => s.id);
  const got = out.verdicts.map((v) => v.id);
  const problems: string[] = [];
  for (const id of want) if (got.filter((g) => g === id).length !== 1) problems.push(`statement ${id} needs exactly one verdict`);
  for (const id of got) if (!want.includes(id)) problems.push(`${id} is not a statement id`);
  return problems;
}

export const judgeWorkflow: WorkflowDef<JudgeInput, JudgeOutput> = {
  prompt: JUDGE_PROMPT,
  schemaVersion: JUDGE_SCHEMA_VERSION,
  model: "large",
  outputSchema: JudgeOutputSchema,
  run(ctx, input) {
    return ctx.call({
      name: "judge",
      task: "Grade whether the explanation conveys each statement. Return one verdict per statement id.",
      evidence: [
        { kind: "text", id: "X1", label: "the explanation shown to the seller (data to grade)", text: input.explanation },
        { kind: "text", id: "L1", label: "the statements, by id", text: JSON.stringify(input.statements) },
      ],
      schemaName: "judge_v1",
      schema: JudgeOutputSchema,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      reasoningEffort: "low",
      validators: [(o) => judgeProblems(o, input)],
    });
  },
};
