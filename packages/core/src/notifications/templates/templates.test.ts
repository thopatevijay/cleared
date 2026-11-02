// M3-08 templates: EN/HI sentences, the seller's time zone, the true remaining time on a late send, one
// link to APP_BASE_URL, escaped HTML, no images or tracking pixels.
import { describe, expect, it } from "vitest";
import { addMinutes, type Instant } from "../../time.ts";
import { deadlineAlert, disputeOpenedNotification, holdOpenedNotification } from "../rules.ts";
import { remaining } from "./format.ts";
import { renderNotification } from "./render.ts";

const DUE = "2026-11-02T18:29:00.000Z" as Instant; // 23:59 IST
const D = "6f0b8e43-3f0e-4c69-9a0e-6f3d1b4b9a11";
const usd = { amount: "120.00", currency: "USD" } as const;
const ctx = (now: Instant, locale: "en" | "hi" = "en") => ({
  locale,
  timeZone: "Asia/Kolkata",
  appBaseUrl: "https://cleared.example/",
  now,
});

function t24(now: Instant) {
  const a = deadlineAlert({ disputeRowId: D, dueDate: DUE, open: true, now, amount: usd, reason: null });
  if (a === null) throw new Error("no alert");
  return a;
}

describe("renderNotification", () => {
  it("T-24 in EN: amount, hours left, the date and time in the seller tz, one link", () => {
    const r = renderNotification(t24(addMinutes(DUE, -18 * 60)), ctx(addMinutes(DUE, -18 * 60)));
    expect(r.sentence).toBe("Reply to the $120.00 USD dispute is due in 18 hours (2 Nov, 23:59 IST).");
    expect(r.subject).toBe(r.sentence);
    expect(r.url).toBe(`https://cleared.example/en/disputes/${D}`);
    expect(r.text).toContain(r.url);
    expect(r.html.match(/<a /g)).toHaveLength(1);
    expect(r.html).not.toMatch(/<img|<script|<style/i);
  });

  it("a late send states the true remaining time, not the band's", () => {
    const alertAt = addMinutes(DUE, -23 * 60);
    const sentAt = addMinutes(DUE, -3 * 60 - 20);
    expect(renderNotification(t24(alertAt), ctx(sentAt)).sentence).toContain("due in 3 hours");
    expect(remaining(DUE, addMinutes(DUE, -71 * 60))).toEqual({ unit: "days", n: 2 });
    expect(remaining(DUE, addMinutes(DUE, -10))).toEqual({ unit: "hours", n: 1 });
  });

  it("HI copy for each kind, with the HI link", () => {
    const now = addMinutes(DUE, -50 * 60);
    const hold = holdOpenedNotification({ holdId: D, paymentId: D, amount: usd, reason: "PENDING_REVIEW" });
    expect(renderNotification(hold, ctx(now, "hi")).sentence).toBe(
      "PayPal ने $120.00 USD रोका है (PENDING_REVIEW)।",
    );
    const opened = disputeOpenedNotification({
      disputeRowId: D,
      amount: usd,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      dueDate: DUE,
    });
    const en = renderNotification(opened, ctx(now));
    expect(en.sentence).toBe(
      "A buyer opened a dispute on $120.00 USD: merchandise or service not received. A reply is being drafted.",
    );
    expect(renderNotification(opened, ctx(now, "hi")).url).toBe(`https://cleared.example/hi/disputes/${D}`);
  });

  it("escapes HTML in every interpolated value", () => {
    const hold = holdOpenedNotification({ holdId: D, paymentId: D, amount: usd, reason: "<b>X</b>" });
    const r = renderNotification(hold, ctx(DUE));
    expect(r.html).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(r.html).not.toContain("<b>");
  });
});
