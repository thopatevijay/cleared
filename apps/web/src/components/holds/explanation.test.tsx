// M3-02 component tests with the real EN/HI messages: the explanation renders as plain text (AC 6: the derived
// HTML-in-output fixture shows its tags escaped, never as elements), the "AI explanation" / "Standard
// explanation" label, the Hindi content marked lang="hi", and the pending state with the EN/HI toggle.
import { readFileSync } from "node:fs";
import {
  ExplainHoldOutputSchema,
  fallbackExplanation,
  fromEpochMs,
  renderExplanation,
  type HoldExplanation,
  type HoldFacts,
} from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { Explanation, ExplanationBody } from "./Explanation.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

const FACTS: HoldFacts = {
  ruleId: "payment_review",
  reason: "PENDING_REVIEW",
  amount: { value: "64.00", currency: "USD" },
  openedAt: fromEpochMs(Date.parse("2026-10-26T11:24:21Z")),
  estimatedReleaseAt: fromEpochMs(Date.parse("2026-10-27T11:24:21Z")),
  timeZone: "UTC",
};
const META = { id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a62", createdAt: "2026-10-26T12:00:00.000Z" };

/** The answer a recorded fixture carries (its message's output_text). */
function recorded(name: string): unknown {
  const url = new URL(`../../../../../fixtures/openai/explain_hold/${name}.json`, import.meta.url);
  const fx = JSON.parse(readFileSync(url, "utf8")) as {
    response: { body: { output: { type: string; content?: { text?: string }[] }[] } };
  };
  const msg = fx.response.body.output.find((o) => o.type === "message");
  return JSON.parse(msg?.content?.[0]?.text ?? "null") as unknown;
}

const fromFixture = (name: string, locale: "en" | "hi"): HoldExplanation => ({
  ...renderExplanation(ExplainHoldOutputSchema.parse(recorded(name)), FACTS, locale, "ai", "explain_hold@v1"),
  ...META,
});

describe("hold explanation (M3-02)", () => {
  it("AC 6: markup in the model's answer renders escaped, as plain text", () => {
    const out = html(<ExplanationBody e={fromFixture("derived-html", "en")} />);
    expect(out).toContain("&lt;b&gt;PayPal&lt;/b&gt; is reviewing your payment of 64.00 USD.");
    expect(out).toContain("&lt;img src=x onerror=alert(&#x27;x&#x27;)&gt;");
    expect(out).not.toMatch(/<b>|<img/);
  });

  it("labels an AI answer and a standard one", () => {
    const ai = html(<ExplanationBody e={fromFixture("payment-review-en", "en")} />);
    expect(ai).toContain("AI explanation");
    expect(ai).toContain('data-origin="ai"');
    const standard: HoldExplanation = {
      ...renderExplanation(fallbackExplanation("payment_review", "en"), FACTS, "en", "standard", "fallback@v1"),
      ...META,
    };
    const out = html(<ExplanationBody e={standard} />);
    expect(out).toContain("Standard explanation (no AI summary right now)");
    expect(out).toContain("What PayPal is doing");
  });

  it("marks the Hindi text lang=hi (the recorded live HI answer)", () => {
    const out = html(<ExplanationBody e={fromFixture("payment-review-hi", "hi")} />, "hi");
    expect(out).toContain('lang="hi"');
    expect(out).toContain("AI व्याख्या");
    expect(out).toContain("64.00 USD");
  });

  it("pending: the toggle (UI language pressed) and the 'usually under 30 seconds' status", () => {
    const out = html(<Explanation holdId={META.id} explanations={[]} released={false} />, "hi");
    expect(out).toMatch(/aria-pressed="true"[^>]*>हिन्दी/);
    expect(out).toContain('role="status"');
    expect(out).toContain("आम तौर पर 30 सेकंड से कम");
    // a released hold without one: no pending line
    expect(html(<Explanation holdId={META.id} explanations={[]} released />)).not.toContain('role="status"');
  });
});
