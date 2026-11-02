// M3-04 AC 4 (UI test, component side) with the real EN/HI messages: the secondary API record always shows
// "Effect on release unconfirmed" (every record state, before and after the seller's confirmation), the
// PayPal Activity link's host follows PAYPAL_ENV (sandbox → www.sandbox.paypal.com + the Sandbox badge; live →
// www.paypal.com), the support quote is shown verbatim in English, and no copy says the API releases money.
import {
  COMPLETED_RECORD_STATES,
  paypalActivityUrl,
  PAYPAL_SUPPORT_QUOTES,
  type CompletedSummary,
  type HoldDetail,
  type PayPalEnv,
} from "@cleared/core";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import { GuidedCompleted } from "./GuidedCompleted.tsx";

const CAPTURE = "7AS90958XD7569923";

function detail(env: PayPalEnv, completed: Partial<CompletedSummary> = {}): HoldDetail {
  return {
    hold: {
      id: "0f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a61",
      paymentId: "1f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a61",
      captureId: CAPTURE,
      amount: { value: "120.00", currency: "USD" },
      state: "open",
      type: "service",
      reason: "OTHER",
      openedAt: "2026-10-30T08:00:00.000Z",
      releasedAt: null,
      estimatedReleaseAt: null,
      estimateUpperBoundAt: null,
      ruleId: "reason_OTHER",
      dispute: null,
      completed: {
        confirmedAt: null,
        activityUrl: paypalActivityUrl(env),
        env,
        record: { state: "none", actionId: null, debugId: null, readBack: null, refusal: null },
        ...completed,
      },
    },
    payment: { id: "1f1d4f0e-3d5b-4b8e-9f7a-1c2d3e4f5a61", status: "PENDING", statusReason: "OTHER" },
    workspace: { timezone: "UTC" },
    explanations: [],
  };
}

const html = (d: HoldDetail, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      <GuidedCompleted d={d} onChanged={() => undefined} />
    </NextIntlClientProvider>,
  );
const text = (m: string): string =>
  m
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");
const activityHref = (m: string): string => {
  const tag = /<a [^>]*data-testid="activity-link"[^>]*>/.exec(m)?.[0] ?? "";
  return /href="([^"]+)"/.exec(tag)?.[1] ?? "";
};

describe("guided Completed step (M3-04)", () => {
  it("the Activity link host follows PAYPAL_ENV", () => {
    const sandbox = html(detail("sandbox"));
    expect(new URL(activityHref(sandbox)).host).toBe("www.sandbox.paypal.com");
    expect(text(sandbox)).toContain("Opens www.sandbox.paypal.com");
    expect(text(sandbox)).toContain("Sandbox");
    const live = html(detail("live"));
    expect(new URL(activityHref(live)).host).toBe("www.paypal.com");
    expect(text(live)).toContain("Opens www.paypal.com");
    expect(live).toContain('target="_blank"');
  });

  it("the secondary record always shows 'Effect on release unconfirmed', in every state", () => {
    for (const state of COMPLETED_RECORD_STATES) {
      for (const confirmedAt of [null, "2026-11-01T12:00:00.000Z"]) {
        const record = {
          state,
          actionId: null,
          debugId: "f35132535c29e",
          readBack: "COMPLETED",
          refusal: "KILL_SWITCH",
        };
        const m = html(detail("sandbox", { confirmedAt, record }));
        expect(m).toContain('data-testid="unconfirmed-badge"');
        expect(text(m)).toContain("Effect on release unconfirmed");
        expect(text(html(detail("sandbox", { confirmedAt, record }), "hi"))).toContain(
          "रिलीज़ पर असर की पुष्टि नहीं",
        );
      }
    }
  });

  it("shows the capture id, the three steps and PayPal support's quote verbatim (English in HI too)", () => {
    for (const locale of ["en", "hi"] as const) {
      const m = html(detail("sandbox"), locale);
      expect(text(m)).toContain(CAPTURE);
      expect(m).toContain('<blockquote lang="en"');
      expect(text(m)).toContain(PAYPAL_SUPPORT_QUOTES.webPath.quote);
    }
    expect(text(html(detail("sandbox")))).toContain("PayPal support, 26 Oct 2026");
  });

  it("the confirmed state shows the date and replaces the confirm button", () => {
    const m = html(detail("sandbox", { confirmedAt: "2026-11-01T12:00:00.000Z" }));
    expect(text(m)).toContain("You marked it Completed on 1 Nov");
    expect(m).not.toContain('data-testid="completed-submit"');
    expect(html(detail("sandbox"))).toContain('data-testid="completed-submit"');
  });

  it("a recorded read-back shows COMPLETED + the debug id; no copy claims the API releases money", () => {
    const record = {
      state: "recorded" as const,
      actionId: null,
      debugId: "f35132535c29e",
      readBack: "COMPLETED",
      refusal: null,
    };
    const m = text(html(detail("sandbox", { record })));
    expect(m).toContain("PayPal reads COMPLETED · debug_id f35132535c29e");
    const api = JSON.stringify(en.holds.completed.api);
    expect(api).not.toMatch(/releases? (the |your )?money|unlock|speeds? up|frees?\b/i);
    expect(m).toContain("This doesn't change your estimate; only the step above does.");
  });
});
