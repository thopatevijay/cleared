// M3-02 core: the explain_hold@v1 guardrails, the standard text and the code-side rendering. The recorded
// answers (fixtures/openai/explain_hold/*) are checked in fixtures.test.ts; the job end to end in apps/worker.
import { describe, expect, it } from "vitest";
import { LOCALES } from "../../accounts/workspace.ts";
import { HOLD_RULES } from "../../holds/rules.ts";
import { fromEpochMs } from "../../time.ts";
import { fallbackExplanation, FALLBACK_RULE_IDS } from "./fallback.ts";
import { dateExpressionIn, explainHoldProblems, explainProblemOf, numbersIn } from "./guardrails.ts";
import { explainHoldInput, fillSlots, renderExplanation, slotValues, type HoldFacts } from "./render.ts";
import { ExplainHoldOutputSchema, StoredExplanationSchema, type ExplainHoldOutput } from "./schema.ts";

const review: HoldFacts = {
  ruleId: "payment_review",
  reason: "PENDING_REVIEW",
  amount: { value: "64.00", currency: "USD" },
  openedAt: fromEpochMs(Date.parse("2026-10-26T11:24:21Z")),
  estimatedReleaseAt: fromEpochMs(Date.parse("2026-10-27T11:24:21Z")),
  timeZone: "Asia/Kolkata",
};
const dispute: HoldFacts = { ...review, ruleId: "dispute_hold", reason: "BUYER_COMPLAINT", estimatedReleaseAt: null };

const ok: ExplainHoldOutput = {
  summary: "PayPal is reviewing your payment of {amount}.",
  whatPayPalIsDoing: "It reviews some payments for up to 24 hours; the release at {estimated_release} is estimated.",
  whatYouCanDo: ["Don't ship yet."],
  ruleId: "payment_review",
};
const input = explainHoldInput(review, "en");
const problems = (o: Partial<ExplainHoldOutput>, i = input) => explainHoldProblems({ ...ok, ...o }, i);
const codes = (o: Partial<ExplainHoldOutput>, i = input) => problems(o, i).map((p) => explainProblemOf(p));

describe("explain_hold input (the cache key)", () => {
  it("is identical for two holds under one rule, reason and locale, whatever their amount and dates", () => {
    const other: HoldFacts = {
      ...review,
      amount: { value: "999.99", currency: "EUR" },
      openedAt: fromEpochMs(Date.parse("2026-11-01T00:00:00Z")),
      estimatedReleaseAt: fromEpochMs(Date.parse("2026-11-02T00:00:00Z")),
    };
    expect(explainHoldInput(other, "en")).toEqual(input);
    expect(JSON.stringify(input)).not.toMatch(/64\.00|2026/);
    expect(explainHoldInput(review, "hi")).not.toEqual(input);
  });

  it("offers {estimated_release} only when the rule gives a timeline", () => {
    expect(input.slots).toEqual(["amount", "opened_at", "estimated_release"]);
    expect(explainHoldInput(dispute, "en").slots).toEqual(["amount", "opened_at"]);
  });
});

describe("explain_hold guardrails", () => {
  it("passes a grounded answer", () => {
    expect(problems({})).toEqual([]);
  });

  it("rejects a rule id that isn't the input's", () => {
    expect(codes({ ruleId: "dispute_hold" })).toEqual(["rule_id_mismatch"]);
  });

  it('rejects a fabricated date ("released on 3 Nov"), even though 3 is in the quote', () => {
    expect(numbersIn(input.rule.sources.map((s) => s.quote).join(" "))).toContain("3");
    expect(codes({ summary: "Your money will be released on 3 Nov (estimated)." })).toContain("date_expression");
    expect(codes({ summary: "पैसा 3 नवंबर को अनुमानित रूप से मिलेगा।" }, explainHoldInput(review, "hi"))).toContain(
      "date_expression",
    );
    expect(codes({ summary: "Expect it by Friday, estimated." })).toEqual(["date_expression"]);
    expect(dateExpressionIn("You may ship once PayPal says so.")).toBeNull();
  });

  it("rejects numbers and amounts that aren't in the input (ASCII or Devanagari digits)", () => {
    expect(codes({ summary: "PayPal holds $64.00 for you." })).toEqual(["foreign_number"]);
    expect(codes({ summary: "It takes 48 hours." })).toEqual(["foreign_number"]);
    expect(codes({ summary: "जाँच २४ घंटे तक चलती है।" }, explainHoldInput(review, "hi"))).toEqual([]);
    expect(codes({ summary: "जाँच ४८ घंटे तक चलती है।" }, explainHoldInput(review, "hi"))).toEqual([
      "foreign_number",
    ]);
  });

  it("rejects a slot the hold doesn't have", () => {
    const d = explainHoldInput(dispute, "en");
    expect(codes({ summary: "Held until {estimated_release}, estimated.", whatPayPalIsDoing: "It holds it.", ruleId: "dispute_hold" }, d)).toEqual([
      "unknown_slot",
    ]);
    expect(codes({ summary: "Paid by {buyer_name}." })).toEqual(["unknown_slot"]);
  });

  it("rejects promise words, EN and HI", () => {
    expect(codes({ summary: "Your release is guaranteed." })).toEqual(["promise_word"]);
    expect(codes({ summary: "PayPal will release the money soon." })).toEqual(["promise_word"]);
    expect(codes({ summary: "PayPal will release the money at {estimated_release} (estimated)." })).toEqual([]);
    const hi = explainHoldInput(review, "hi");
    expect(codes({ summary: "पैसा ज़रूर रिलीज़ हो जाएगा।" }, hi)).toEqual(["promise_word", "promise_word"]);
    expect(codes({ summary: "अनुमान है कि पैसा रिलीज़ हो जाएगा।" }, hi)).toEqual([]);
    expect(codes({ summary: "आपको किसी कार्रवाई की ज़रूरत नहीं है।" }, hi)).toEqual([]);
  });

  it("rejects the wrong language", () => {
    expect(codes({ summary: "PayPal is reviewing it." }, explainHoldInput(review, "hi"))).toEqual(["wrong_language"]);
    expect(codes({ summary: "PayPal जाँच कर रहा है।" })).toEqual(["wrong_language"]);
  });
});

describe("the standard explanation (fallback)", () => {
  it.each(HOLD_RULES.flatMap((r) => LOCALES.map((l) => [r.id, l] as const)))(
    "%s (%s) is schema-valid and passes every guardrail",
    (ruleId, locale) => {
      const rule = HOLD_RULES.find((r) => r.id === ruleId);
      const facts: HoldFacts = {
        ...review,
        ruleId,
        reason: rule?.appliesTo.kind === "reason" ? (rule.appliesTo.reasons[0] ?? "OTHER") : "OTHER",
        estimatedReleaseAt: rule?.estimate(review.openedAt)?.at ?? null,
      };
      const out = fallbackExplanation(ruleId, locale);
      expect(ExplainHoldOutputSchema.safeParse(out).success).toBe(true);
      expect(explainHoldProblems(out, explainHoldInput(facts, locale))).toEqual([]);
    },
  );

  it("has its own text for the four derivable rows with a workflow", () => {
    expect(FALLBACK_RULE_IDS).toEqual(["payment_review", "dispute_hold", "goods_delivered", "service_completed"]);
    expect(fallbackExplanation("reason_ECHECK", "hi").summary).toContain("PayPal");
  });
});

describe("rendering (code fills the values)", () => {
  it("fills the slots with this hold's amount and dates and adds the estimate and source", () => {
    const s = renderExplanation(ok, review, "en", "ai", "explain_hold@v1");
    expect(StoredExplanationSchema.parse(s)).toEqual(s);
    expect(s.summary).toBe("PayPal is reviewing your payment of 64.00 USD.");
    expect(s.whatPayPalIsDoing).toContain("Oct 27, 2026");
    expect(s.estimate).toEqual({ at: review.estimatedReleaseAt, label: "estimated" });
    expect(s.source.url).toMatch(/^https:\/\/developer\.paypal\.com\//);
    expect(renderExplanation(ok, dispute, "en", "standard", "fallback@v1").estimate).toBeNull();
  });

  it("formats Hindi dates in the workspace's zone", () => {
    const v = slotValues(review, "hi");
    expect(v.amount).toBe("64.00 USD");
    expect(fillSlots("{estimated_release}", v)).toMatch(/2026/);
  });

  it("keeps markup as plain text (rendering escapes it; nothing is stripped or interpreted here)", () => {
    const s = renderExplanation({ ...ok, summary: "<b>Held</b> {amount}" }, review, "en", "ai", "explain_hold@v1");
    expect(s.summary).toBe("<b>Held</b> 64.00 USD");
  });
});
