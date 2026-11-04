// M3-02 AC 1/2 at the core level: the live `explain_hold@v1` answers (gpt-6-luna, 2026-11-02) in
// fixtures/openai/explain_hold/ pass the schema and every guardrail for their rule and locale; the derived
// fabricated-date answer does not. The same fixtures replay over HTTP + Postgres in apps/worker.
import { describe, expect, it } from "vitest";
import { recordedExplanation } from "../../../test/helpers/explain-fixtures.ts";
import { fromEpochMs } from "../../time.ts";
import { explainHoldProblems, explainProblemOf } from "./guardrails.ts";
import { explainHoldInput, type HoldFacts } from "./render.ts";
import { ExplainHoldOutputSchema } from "./schema.ts";

const at = (iso: string) => fromEpochMs(Date.parse(iso));
const facts = (ruleId: string, reason: string, estimated: string | null): HoldFacts => ({
  ruleId,
  reason,
  amount: { value: "64.00", currency: "USD" },
  openedAt: at("2026-10-26T11:24:21Z"),
  estimatedReleaseAt: estimated === null ? null : at(estimated),
  timeZone: "Asia/Kolkata",
});
const review = facts("payment_review", "PENDING_REVIEW", "2026-10-27T11:24:21Z");
const dispute = facts("dispute_hold", "BUYER_COMPLAINT", null);

describe("recorded explain_hold@v2 answers (fixture replay)", () => {
  it.each([
    ["payment-review-en", review, "en"],
    ["payment-review-hi", review, "hi"],
    ["dispute-hold-en", dispute, "en"],
    ["dispute-hold-hi", dispute, "hi"],
  ] as const)("%s passes the schema and every guardrail, ruleId matching", (name, f, locale) => {
    const out = ExplainHoldOutputSchema.parse(recordedExplanation(name));
    expect(out.ruleId).toBe(f.ruleId);
    expect(explainHoldProblems(out, explainHoldInput(f, locale))).toEqual([]);
  });

  it('rejects the derived answer with a fabricated date ("released on 3 Nov")', () => {
    const out = ExplainHoldOutputSchema.parse(recordedExplanation("derived-fabricated-date"));
    const problems = explainHoldProblems(out, explainHoldInput(review, "en"));
    expect(problems.map(explainProblemOf)).toContain("date_expression");
  });
});
