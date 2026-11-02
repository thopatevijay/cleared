// M3-01 component tests with the real EN/HI messages: "Don't ship yet" only for a rule whose cited
// source carries it, EstimatedDate ("Free by … · estimated · Source", never an undated "~"), the dispute
// and no-timeline variants, the dashboard held row's single action, and the badged sample scenarios.
import { holdRule, type PaymentHold, type PaymentItem } from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { PaymentRow } from "../PaymentRow.tsx";
import { EstimatedDate } from "./EstimatedDate.tsx";
import { AdviceLine } from "./HeldLines.tsx";
import { SampleScenarios } from "./SampleScenarios.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const text = (m: string): string =>
  m
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const REVIEW: PaymentHold = {
  id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a61",
  type: "review",
  reason: "PENDING_REVIEW",
  ruleId: "payment_review",
  estimatedReleaseAt: "2026-10-29T10:00:00.000Z",
  estimateUpperBoundAt: "2026-10-31T10:00:00.000Z",
};

describe("advice line (dashboard.md element 9)", () => {
  it("shows 'Don't ship yet' with its source for a rule whose source carries it", () => {
    const out = html(<AdviceLine ruleId="payment_review" />);
    expect(text(out)).toContain("Don't ship yet: PayPal is reviewing this payment");
    const quote = holdRule("payment_review")?.sources[1]?.quote ?? "";
    expect(text(out)).toContain(quote.replaceAll("'", "'"));
    expect(text(out)).toContain("Don't ship until we tell you it's ok.");
  });

  it("shows nothing for a rule whose source does not", () => {
    expect(html(<AdviceLine ruleId="dispute_hold" />)).toBe("");
    expect(html(<AdviceLine ruleId="reason_ECHECK" />)).toBe("");
    expect(html(<AdviceLine ruleId="goods_delivered" />)).toBe("");
  });
});

describe("EstimatedDate", () => {
  it("dated: 'Free by 29 Oct · estimated · Source', never a bare '~'", () => {
    const out = text(html(<EstimatedDate e={REVIEW} timeZone="UTC" />));
    expect(out).toMatch(/Free by 29 Oct · estimated · Source/);
    expect(out).not.toContain("~");
    expect(html(<EstimatedDate e={REVIEW} timeZone="UTC" />)).toContain(
      'aria-label="Estimated release 29 October 2026, source PayPal transaction event codes: T2105 Payment review hold"',
    );
  });

  it("full form: the rule's sentence, estimated, and the 3-business-day bound", () => {
    const out = text(html(<EstimatedDate e={REVIEW} timeZone="UTC" full />));
    expect(out).toContain("Within 24 hours; up to 3 business days · estimated");
    expect(out).toContain("Free by 29 Oct · up to 31 Oct");
  });

  it("dispute-linked: no date, the reply deadline instead; no timeline: says so with the source", () => {
    const dispute = text(
      html(
        <EstimatedDate
          e={{
            ruleId: "dispute_hold",
            estimatedReleaseAt: null,
            estimateUpperBoundAt: null,
            disputeDueAt: "2026-11-02T18:29:59.000Z",
          }}
          timeZone="UTC"
        />,
      ),
    );
    expect(dispute).toContain("Released when the dispute is resolved · Dispute reply due 2 Nov");
    expect(dispute).not.toContain("Free by");
    const none = text(
      html(
        <EstimatedDate
          e={{ ruleId: "reason_ECHECK", estimatedReleaseAt: null, estimateUpperBoundAt: null }}
          timeZone="UTC"
        />,
      ),
    );
    expect(none).toContain("PayPal gives no timeline for this reason");
    expect(none).toContain("The payer paid by an eCheck that has not yet cleared.");
  });

  it("HI keeps 'अनुमानित' and the source", () => {
    const out = text(html(<EstimatedDate e={REVIEW} timeZone="UTC" />, "hi"));
    expect(out).toContain("अनुमानित");
    expect(out).toContain("स्रोत");
  });
});

describe("dashboard held row", () => {
  const row = (hold: PaymentHold | null, empty = true): PaymentItem => ({
    id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6c",
    captureId: "5JB55617195805514",
    amount: { value: "64.00", currency: "USD" },
    receivable: null,
    status: "PENDING",
    statusReason: "PENDING_REVIEW",
    source: "webhook",
    updatedAt: "2026-10-26T11:24:21.000Z",
    pack: {
      id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a6d",
      view: "empty",
      hasEvidence: !empty,
      proofReady: false,
      summary: null,
    },
    hold,
  });

  it("held badge + PENDING_REVIEW + estimate + exactly one row action ('Why?' → #why)", () => {
    const out = html(
      <ul>
        <PaymentRow p={row(REVIEW)} timeZone="UTC" flash={false} />
      </ul>,
    );
    expect(text(out)).toContain("Held");
    expect(out).toContain("PENDING_REVIEW");
    expect(text(out)).toContain("Free by 29 Oct · estimated · Source");
    expect(out).toContain(`href="/en/holds/${REVIEW.id}#why"`);
    expect(out.match(/data-testid="(why|add-proof|review-approve)"/g)).toEqual(['data-testid="why"']);
    expect(out).toContain('aria-label="Why is $64.00 USD held?"');
  });

  it("goods holds say tracking can help; a payment without a hold has no held lines", () => {
    const goods = html(
      <ul>
        <PaymentRow
          p={row({ ...REVIEW, type: "goods", ruleId: "goods_delivered" })}
          timeZone="UTC"
          flash={false}
        />
      </ul>,
    );
    expect(text(goods)).toContain("Tracking can help release this");
    expect(text(goods)).not.toContain("Don't ship yet");
    const plain = html(
      <ul>
        <PaymentRow
          p={{ ...row(null), status: "COMPLETED", statusReason: null }}
          timeZone="UTC"
          flash={false}
        />
      </ul>,
    );
    expect(plain).not.toContain('data-testid="held-lines"');
    expect(plain).toContain('data-testid="add-proof"');
  });
});

describe("sample scenarios", () => {
  it("three badged explainers with PayPal's words, no amount, no action", () => {
    const out = html(<SampleScenarios />);
    expect(out.match(/data-testid="sample"/g)?.length).toBe(3);
    expect(out.match(/Sample scenario: sandbox can&#x27;t produce this/g)?.length).toBe(3);
    expect(text(out)).not.toMatch(/\$\d/);
    expect(out).not.toContain("700");
    expect(text(out)).toContain("Account limitation");
  });
});
