// M2-10 AC3 (component side): "Simulate PayPal's decision (sandbox only)" is absent when PAYPAL_ENV isn't
// sandbox and disabled, with the reason, without the adjudicate link; the timeline shows real PayPal ids
// and the outcome uses "seller keeps the money (PayPal covered the case)". Rendered server-side with the
// real EN/HI messages.
import { decisionAvailability, scenarioTimeline, type DecisionInput, type ScenarioView } from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { SandboxDecision } from "./SandboxDecision.tsx";
import { ScenarioTimeline } from "./ScenarioTimeline.tsx";
import { ScenarioOutcome } from "./ScenarioView.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

const ready: DecisionInput = {
  paypalEnv: "sandbox",
  state: "polling",
  disputeId: "PP-R-TST-1",
  ownsDispute: true,
  evidenceFiled: true,
  allowedActions: ["adjudicate"],
  decisionRequested: false,
};
const decision = (patch: Partial<DecisionInput>): ScenarioView["decision"] => ({
  ...decisionAvailability({ ...ready, ...patch }),
  requestedAt: null,
  sentAt: null,
  error: null,
});
const control = (d: ScenarioView["decision"], locale: "en" | "hi" = "en") =>
  html(
    <SandboxDecision
      scenarioId="00000000-0000-4000-8000-000000000000"
      decision={d}
      onRequested={() => undefined}
    />,
    locale,
  );

describe("SandboxDecision", () => {
  it("is absent (renders nothing) when PAYPAL_ENV is not sandbox", () => {
    expect(control(decision({ paypalEnv: "live" }))).toBe("");
    expect(control(decision({ paypalEnv: undefined }))).toBe("");
  });

  it("is disabled with 'PayPal isn't ready yet' without the adjudicate link", () => {
    const out = control(decision({ allowedActions: ["provide_evidence", "accept_claim"] }));
    expect(out).toContain("Simulate PayPal&#x27;s decision (sandbox only)");
    expect(out).toMatch(/<button[^>]*disabled=""/);
    expect(out).toContain("PayPal isn&#x27;t ready yet: it hasn&#x27;t offered the decision step.");
    expect(out).toContain("Stands in for PayPal&#x27;s own review.");
  });

  it("is disabled with 'File your evidence first' before our evidence is filed", () => {
    const out = control(decision({ evidenceFiled: false }));
    expect(out).toMatch(/<button[^>]*disabled=""/);
    expect(out).toContain("File your evidence first.");
  });

  it("is enabled when PayPal offers adjudicate on our filed, owned dispute; the label stays verbatim in HI", () => {
    const out = control(decision({}));
    expect(out.match(/<button[^>]*>/)?.[0]).not.toContain(`disabled=""`);
    expect(out.match(/<button/g)?.length).toBe(3);
    expect(out).not.toContain('data-testid="decision-reason"');
    expect(control(decision({}), "hi")).toContain("Simulate PayPal&#x27;s decision (sandbox only)");
  });
});

describe("ScenarioTimeline and outcome", () => {
  const steps = scenarioTimeline({
    state: "resolved",
    steps: {
      capture: {
        at: "2026-10-31T12:00:00Z",
        orderId: "5O190127TN364715T",
        captureId: "3C679366HH908993F",
        status: "COMPLETED",
        merchantId: "M",
      },
      seed_pack: { at: "2026-10-31T12:00:05Z", packId: "p", evidenceItemIds: ["a", "b", "c"] },
      chargeback: { at: "2026-10-31T12:00:10Z", disputeId: "PP-R-UVC-10195076", adopted: false },
    },
    dispute: { status: "RESOLVED", allowedActions: [], updatedAt: "2026-10-31T12:21:00Z" },
    capture: { status: "COMPLETED", reason: null },
    evidenceFiledAt: "2026-10-31T12:05:00Z",
    decisionRequestedAt: "2026-10-31T12:10:00Z",
    finishedAt: "2026-10-31T12:22:00Z",
  });

  it("lists every step with the real PayPal ids", () => {
    const out = html(<ScenarioTimeline steps={steps} locale="en" timeZone="UTC" />);
    for (const id of ["5O190127TN364715T", "3C679366HH908993F", "PP-R-UVC-10195076"])
      expect(out).toContain(id);
    expect(out.match(/data-status="done"/g)?.length).toBe(7);
  });

  it("words the payout outcome as PayPal covering the case, and the hold as released (EN + HI)", () => {
    const s = {
      outcome: "payout_paypal_covered",
      holdReleased: true,
      dispute: {
        status: "RESOLVED",
        outcome: { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" },
      },
      capture: { captureId: "C", status: "COMPLETED", reason: null },
    } as unknown as ScenarioView;
    const out = html(<ScenarioOutcome s={s} />);
    expect(out).toContain("Resolved; seller keeps the money (PayPal covered the case)");
    expect(out).toContain("Hold released: payment is Completed");
    expect(out).not.toMatch(/\bwon\b/i);
    expect(html(<ScenarioOutcome s={s} />, "hi")).toContain("PayPal ने मामला कवर किया");
    expect(html(<ScenarioOutcome s={{ ...s, outcome: null }} />)).toBe("");
  });
});
