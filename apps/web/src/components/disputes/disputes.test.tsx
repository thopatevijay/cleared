// M2-09 component tests (rendered server-side with the real EN/HI messages, like M2-10's):
// - AC 3: the count turns to error above 2000 and Approve is disabled
// - AC 4: DEADLINE_PASSED, ACTION_LINK_MISSING, KILL_SWITCH, RECONCILE_NOT_APPLIED each render a localised
//   message (EN and HI), on a failed filing and on a refused approval
// - AC 5: Accept claim is disabled until the typed confirmation matches exactly
// - outcome wording: RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL reads exactly the approved sentence
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json" with { type: "json" };
import hi from "../../../messages/hi.json" with { type: "json" };
import type { ActionViewData, DisputeDetail, Draft } from "../../lib/dispute-view.ts";
import { AcceptClaimBody, canAcceptClaim } from "./AcceptClaimDialog.tsx";
import { DraftReview } from "./DraftReview.tsx";
import { FilingStatus } from "./FilingStatus.tsx";
import { Outcome } from "./Outcome.tsx";

const html = (node: ReactNode, locale: "en" | "hi" = "en"): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
const decode = (s: string): string =>
  s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const SHA = "9f3c1a7e".padEnd(64, "0");
const action = (patch: Partial<ActionViewData> = {}): ActionViewData => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "provide_evidence",
  state: "proposed",
  risk: "high",
  createdBy: "agent",
  payload: {},
  payload_sha256: SHA,
  refusal: null,
  typedConfirmation: null,
  approval: null,
  execution: null,
  ...patch,
});

function detail(notes: string, patch: Partial<DisputeDetail> = {}): DisputeDetail & { draft: Draft } {
  const draft: Draft = {
    id: "00000000-0000-4000-8000-000000000002",
    actionKind: "provide_evidence",
    evidenceType: "OTHER",
    reasonUnmapped: false,
    notes,
    items: [
      {
        id: "00000000-0000-4000-8000-000000000003",
        ref: "E1",
        kind: "delivery",
        mime: "application/pdf",
        size: 1200,
        addedAt: "2026-10-18T10:00:00.000Z",
        selected: true,
        fileUrl: "/api/evidence/00000000-0000-4000-8000-000000000003/file",
      },
    ],
    pdf: { url: "/api/disputes/x/draft/pdf?draft=y", bytes: 129_619 },
    action: action(),
    allowed: true,
  };
  return {
    dispute: {
      id: "00000000-0000-4000-8000-000000000010",
      disputeId: "PP-D-27153",
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "INQUIRY",
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      amount: { value: "120.00", currency: "USD" },
      dueDate: "2026-11-09T04:59:59.000Z",
      deadlineState: "ok",
      outcome: null,
      payment: null,
      draftReady: true,
      allowedActions: ["accept_claim", "provide_evidence"],
      paypalUpdatedAt: null,
    },
    draftOutcome: null,
    acceptClaim: null,
    killSwitch: false,
    scenarioId: null,
    audit: [],
    workspace: { timezone: "Asia/Kolkata" },
    ...patch,
    draft,
  };
}

const review = (d: DisputeDetail & { draft: Draft }, locale: "en" | "hi" = "en") =>
  html(<DraftReview detail={d} onChanged={() => Promise.resolve()} onDialog={() => undefined} />, locale);
const approveButton = (out: string): string => /<button[^>]*data-testid="approve"[^>]*>/.exec(out)?.[0] ?? "";

describe("DraftReview character count (AC 3)", () => {
  it("shows n / 2000 and an enabled Approve at the limit", () => {
    const out = review(detail("a".repeat(2000)));
    expect(out).toContain("2,000 / 2000");
    expect(out).toContain('data-over="false"');
    expect(approveButton(out)).not.toContain('disabled=""');
  });

  it("turns to error above 2000 and disables Approve with the reason", () => {
    const out = review(detail("a".repeat(2001)));
    expect(out).toContain('data-over="true"');
    expect(out).toContain("Over the 2000-character limit");
    expect(out).toContain('aria-invalid="true"');
    expect(approveButton(out)).toContain('disabled=""');
    expect(out).toContain("Shorten the notes to 2000 characters to approve.");
  });

  it("counts code points, not UTF-16 units (Devanagari and emoji)", () => {
    const out = review(detail("😀".repeat(1500)));
    expect(out).toContain("1,500 / 2000");
    expect(approveButton(out)).not.toContain('disabled=""');
  });

  it("renders model notes as text, never HTML", () => {
    const out = review(detail('<script>alert("x")</script>'));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("disables Approve with the kill-switch banner when sending is paused", () => {
    const out = review(detail("ok", { killSwitch: true }));
    expect(out).toContain("Sending to PayPal is paused. Your draft is saved.");
    expect(approveButton(out)).toContain('disabled=""');
  });

  it("shows the draft fingerprint the approval binds to", () => {
    expect(review(detail("ok"))).toMatch(/data-testid="fingerprint"[^>]*>9f3c1a7e</);
  });
});

const REFUSALS: Record<string, { en: string; hi: string }> = {
  DEADLINE_PASSED: {
    en: "PayPal's deadline is less than 1 hour away, so Cleared won't file. Reply in PayPal directly.",
    hi: hi.disputes.refusal.DEADLINE_PASSED,
  },
  ACTION_LINK_MISSING: {
    en: "PayPal no longer allows this reply on this dispute.",
    hi: hi.disputes.refusal.ACTION_LINK_MISSING,
  },
  KILL_SWITCH: { en: "Sending is paused by the operator.", hi: hi.disputes.refusal.KILL_SWITCH },
  RECONCILE_NOT_APPLIED: {
    en: "PayPal didn't record the reply. Review and approve again.",
    hi: hi.disputes.refusal.RECONCILE_NOT_APPLIED,
  },
};

describe("refusal codes render localised messages (AC 4)", () => {
  for (const [code, msg] of Object.entries(REFUSALS)) {
    it(`${code}: failed filing in EN and HI, with the re-propose step`, () => {
      const failed = action({
        state: "failed",
        refusal: code,
        execution: { paypalStatus: null, paypalDebugId: "f1a2b3c4d5e6" },
      });
      const node = (
        <FilingStatus
          action={failed}
          timeZone="UTC"
          canRepropose
          reproposing={false}
          onRepropose={() => undefined}
        />
      );
      const outEn = decode(html(node));
      expect(outEn).toContain(msg.en);
      expect(outEn).toContain('role="alert"');
      expect(outEn).toContain("Review and approve again");
      expect(outEn).toContain("f1a2b3c4d5e6");
      expect(msg.hi).not.toBe(msg.en);
      expect(decode(html(node, "hi"))).toContain(msg.hi);
    });
  }

  it("an unknown code falls back to a message naming the code", () => {
    const out = decode(
      html(
        <FilingStatus
          action={action({ state: "failed", refusal: "SOMETHING_NEW" })}
          timeZone="UTC"
          canRepropose={false}
          reproposing={false}
          onRepropose={() => undefined}
        />,
      ),
    );
    expect(out).toContain("Something went wrong (SOMETHING_NEW)");
    expect(out).not.toContain("Review and approve again");
  });

  it("marks the current step and states unknown as 'checking with PayPal'", () => {
    const out = decode(
      html(
        <FilingStatus
          action={action({ state: "unknown" })}
          timeZone="UTC"
          canRepropose={false}
          reproposing={false}
          onRepropose={() => undefined}
        />,
      ),
    );
    expect(out).toMatch(/aria-current="step"[^>]*data-step="unknown"/);
    expect(out).toContain("Checking with PayPal: the reply may have been received.");
  });
});

describe("Accept claim typed confirmation (AC 5)", () => {
  const body = (typed: string) =>
    html(
      <AcceptClaimBody
        id="a"
        expected="120.00 USD"
        amountText="120.00 USD"
        typed={typed}
        onTyped={() => undefined}
        busy={false}
        error={null}
        onCancel={() => undefined}
        onAccept={() => undefined}
      />,
    );
  const confirm = (out: string) => /<button[^>]*data-testid="accept-confirm"[^>]*>/.exec(out)?.[0] ?? "";

  it.each(["", "120", "120.00", "120.00 usd", " 120.00 USD", "120.00 USD ", "120 USD", "$120.00 USD"])(
    "stays disabled for %j",
    (typed) => {
      expect(canAcceptClaim(typed, "120.00 USD")).toBe(false);
      expect(confirm(body(typed))).toContain('disabled=""');
    },
  );

  it("enables only on the exact amount + currency", () => {
    expect(canAcceptClaim("120.00 USD", "120.00 USD")).toBe(true);
    expect(confirm(body("120.00 USD"))).not.toContain('disabled=""');
    expect(body("")).toContain("Type 120.00 USD to confirm");
  });

  it("is never enabled without a known dispute amount", () => {
    expect(canAcceptClaim("", null)).toBe(false);
  });
});

describe("Outcome wording", () => {
  const resolved = (outcome_code: string, outcome_reason: string | null) =>
    decode(
      html(
        <Outcome
          d={{ ...detail("x").dispute, status: "RESOLVED", outcome: { outcome_code, outcome_reason } }}
        />,
      ),
    );

  it("RESOLVED_WITH_PAYOUT + REPRESENTED_BY_PAYPAL reads exactly the approved sentence (EN, HI)", () => {
    expect(resolved("RESOLVED_WITH_PAYOUT", "REPRESENTED_BY_PAYPAL")).toContain(
      ">Resolved; you keep the money (PayPal covered the case)<",
    );
    const d = {
      ...detail("x").dispute,
      status: "RESOLVED",
      outcome: { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" },
    };
    expect(html(<Outcome d={d} />, "hi")).toContain(
      "निपटारा हुआ; पैसा आपके पास रहेगा (PayPal ने मामला कवर किया)",
    );
  });

  it("other outcomes use PayPal's meaning and code, never a victory", () => {
    const out = resolved("RESOLVED_BUYER_FAVOUR", null);
    expect(out).toContain("Resolved: the buyer is refunded (RESOLVED_BUYER_FAVOUR)");
    expect(out).not.toMatch(/\bwon\b/i);
  });

  it("renders nothing until PayPal reports RESOLVED", () => {
    expect(html(<Outcome d={detail("x").dispute} />)).toBe("");
  });
});
