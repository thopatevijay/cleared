// BL-01 6570499264 (option A, ADR 0017 addendum 3), component side with the real EN/HI messages: the
// declaration is always labelled as the seller's ("You marked this as goods"), and on a hold PayPal didn't
// type goods/service (here a PENDING_REVIEW hold) no release-speed copy shows: no "Tracking can help release
// this", no "Faster release expected… after delivery", no "7 days after you mark the order Completed".
import {
  paypalActivityUrl,
  trackingSummary,
  type Declaration,
  type HoldDetail,
  type PaymentHold,
} from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { RouteAdvice, RouteAdviceLine } from "../tracking/RouteAdvice.tsx";
import { DeclarationControl } from "./DeclarationControl.tsx";
import { GuidedCompleted } from "./GuidedCompleted.tsx";
import { HeldLines } from "./HeldLines.tsx";
import { ActionSlot } from "./HoldDetailView.tsx";

const ID = "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a61";
const tracking = trackingSummary({
  holdState: "open",
  action: null,
  shipment: { carrier: "IND_DELHIVERY", tracking_number: "SPK1" },
  timeZone: "Asia/Kolkata",
});
const flagged = trackingSummary({
  holdState: "open",
  action: null,
  shipment: { carrier: "India Post", tracking_number: "EE123456789IN" },
  timeZone: "Asia/Kolkata",
});

const decl = (o: Partial<Declaration> = {}): Declaration => ({
  kind: null,
  declaredAt: null,
  declarable: true,
  locked: false,
  ...o,
});

function review(o: Partial<HoldDetail["hold"]> = {}): HoldDetail {
  return {
    hold: {
      id: ID,
      paymentId: ID,
      captureId: "7AS90958XD7569923",
      amount: { value: "64.00", currency: "USD" },
      state: "open",
      type: "review",
      reason: "PENDING_REVIEW",
      openedAt: "2026-10-26T11:24:21.000Z",
      releasedAt: null,
      estimatedReleaseAt: "2026-10-27T11:24:21.000Z",
      estimateUpperBoundAt: "2026-10-29T11:24:21.000Z",
      ruleId: "payment_review",
      dispute: null,
      declaration: decl(),
      guidedAction: null,
      ...o,
    },
    payment: { id: ID, status: "PENDING", statusReason: "PENDING_REVIEW" },
    workspace: { timezone: "UTC" },
    explanations: [],
  };
}

const render = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
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

/** Every release-speed phrase that belongs only to holds PayPal itself typed goods / service. */
const RELEASE_CLAIMS = [
  en.holds.trackingHelps,
  en.holds.tracking.tier.approved,
  en.holds.tracking.alternatives,
  en.holds.tracking.nudge.split("{")[0] ?? "",
  en.holds.est.delivered,
  en.holds.completed.intro,
  "faster",
  "Faster",
];

const noop = () => undefined;

describe("the seller's declaration (BL-01 6570499264)", () => {
  it("undeclared: asks 'What did you sell?' with goods / service, says PayPal doesn't say, nothing claimed", () => {
    for (const locale of ["en", "hi"] as const) {
      const m = render(<DeclarationControl d={review()} onChanged={noop} />, locale);
      expect(m).toContain('data-testid="declare-goods"');
      expect(m).toContain('data-testid="declare-service"');
      expect(m).toContain("<legend");
    }
    const m = text(render(<DeclarationControl d={review()} onChanged={noop} />));
    expect(m).toContain("What did you sell?");
    expect(m).toContain("PayPal doesn't say.");
    expect(m).not.toContain("You marked");
  });

  it("declared: labelled as the seller's answer, never PayPal's; says PayPal's estimate stands", () => {
    for (const kind of ["goods", "service"] as const) {
      const d = review({ declaration: decl({ kind, declaredAt: "2026-10-27T09:00:00.000Z" }) });
      const m = text(render(<DeclarationControl d={d} onChanged={noop} />));
      expect(m).toContain(kind === "goods" ? "You marked this as goods" : "You marked this as a service");
      expect(m).toContain("This is your answer, not PayPal's.");
      expect(m).toContain("The estimate above is still PayPal's for this hold");
      expect(m).toContain("Change");
      const hiText = text(render(<DeclarationControl d={d} onChanged={noop} />, "hi"));
      expect(hiText).toContain(kind === "goods" ? "आपने इसे सामान बताया है" : "आपने इसे सेवा बताया है");
    }
  });

  it("locked after an approval: no Change, the lock reason shows", () => {
    const d = review({
      declaration: decl({ kind: "goods", declaredAt: "2026-10-27T09:00:00.000Z", locked: true }),
    });
    const m = render(<DeclarationControl d={d} onChanged={noop} />);
    expect(m).toContain('data-testid="declaration-locked"');
    expect(m).not.toContain('data-testid="declaration-change"');
    expect(m).not.toContain('data-testid="declaration-form"');
  });

  it("not declarable (PayPal typed it, or released): renders nothing", () => {
    const m = render(
      <DeclarationControl d={review({ declaration: decl({ declarable: false }) })} onChanged={noop} />,
    );
    expect(m).toBe("");
  });

  it("route advice on a declared-goods review hold: neutral copy, no release-speed claim", () => {
    for (const s of [tracking, flagged]) {
      const full = text(render(<RouteAdvice s={s} releaseClaims={false} />));
      const line = text(render(<RouteAdviceLine s={s} releaseClaims={false} />));
      for (const claim of RELEASE_CLAIMS) {
        expect(full).not.toContain(claim);
        expect(line).not.toContain(claim);
      }
    }
    // a hold PayPal typed goods keeps M3-03's copy
    expect(text(render(<RouteAdvice s={tracking} />))).toContain(en.holds.tracking.tier.approved);
  });

  it("the dashboard row of a declared-goods review hold: 'You marked this as goods', File tracking, no claims", () => {
    const hold: PaymentHold = {
      id: ID,
      type: "review",
      reason: "PENDING_REVIEW",
      ruleId: "payment_review",
      estimatedReleaseAt: "2026-10-27T11:24:21.000Z",
      estimateUpperBoundAt: "2026-10-29T11:24:21.000Z",
      tracking: flagged,
      declaration: decl({ kind: "goods", declaredAt: "2026-10-27T09:00:00.000Z" }),
      guidedAction: "tracking",
    };
    const m = render(<HeldLines hold={hold} amount="64.00 USD" timeZone="UTC" action />);
    expect(m).toContain('data-testid="file-tracking"');
    const t = text(m);
    expect(t).toContain("You marked this as goods");
    for (const claim of RELEASE_CLAIMS) expect(t).not.toContain(claim);
    // PayPal's review advice (from the Holds panel source) still shows
    expect(t).toContain(en.holds.dontShip);
  });

  it("the Completed step on a declared-service review hold: no 7-day claim; says the estimate won't change", () => {
    const d = review({
      guidedAction: "completed",
      declaration: decl({ kind: "service", declaredAt: "2026-10-27T09:00:00.000Z" }),
      completed: {
        confirmedAt: null,
        activityUrl: paypalActivityUrl("sandbox"),
        env: "sandbox",
        record: { state: "none", actionId: null, debugId: null, readBack: null, refusal: null },
      },
    });
    const m = text(render(<GuidedCompleted d={d} onChanged={noop} />));
    expect(m).not.toContain(en.holds.completed.intro);
    expect(m).toContain("so marking it Completed won't change its estimate");
    expect(m).toContain("Effect on release unconfirmed");
  });
});

describe("the action slot's closing line (hold.md, sweep M5 decision 5)", () => {
  it("the goods/service question is open: 'answering is optional', never 'nothing to do' under it (EN/HI)", () => {
    const m = text(render(<ActionSlot d={review()} onChanged={noop} />));
    expect(m).toContain(en.holds.detail.declareFirst);
    expect(m).not.toContain(en.holds.detail.nothingToDo);
    const h = text(render(<ActionSlot d={review()} onChanged={noop} />, "hi"));
    expect(h).toContain(hi.holds.detail.declareFirst);
    expect(h).not.toContain(hi.holds.detail.nothingToDo);
  });

  it("not declarable with no action: 'No action needed in Cleared', which can't contradict the steps", () => {
    const d = review({ type: "other", declaration: decl({ declarable: false }) });
    const m = text(render(<ActionSlot d={d} onChanged={noop} />));
    expect(m).toContain("No action needed in Cleared.");
    expect(m).not.toContain(en.holds.detail.declareFirst);
    expect(m).not.toContain("Nothing to do");
  });
});
