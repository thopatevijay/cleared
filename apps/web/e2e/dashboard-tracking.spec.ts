// M3-03 E2E (local): dashboard.md elements 10–12 on goods hold rows. A goods hold whose shipment evidence
// names India Post (an `accepted` carrier) shows the route-advice line as icon + text: "…: PayPal accepts
// it; it may not speed up the release. Faster: Delhivery, DTDC, Ekart, BLUEDART", both Sources and the
// sandbox caveat, and the single row action "File tracking". A goods hold with Delhivery (`approved`)
// shows no warning. The words "not approved" never appear. axe (WCAG 2.2 A/AA), 360–1440 px light/dark; HI.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean } from "./support/holds.ts";
import { REVIEW_TRACKING, seedGoods } from "./support/tracking.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("route advice on an accepted carrier, none on an approved one; File tracking", async ({ page }) => {
  test.setTimeout(240_000);
  const ws = await demoWorkspace(page);
  const india = await seedGoods(ws, {
    amount: "420.00",
    shipment: { carrier: "India Post", tracking_number: "EE123456789IN" },
  });
  const delhivery = await seedGoods(ws, {
    amount: "64.00",
    shipment: { carrier: "Delhivery", tracking_number: "SPK123456" },
  });
  await page.goto("/en/payments");

  const row = page.locator(`[data-testid="payment-row"][data-hold="${india.holdId}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("tracking-hint")).toHaveText("Tracking can help release this");
  const advice = row.getByTestId("route-advice");
  await expect(advice).toHaveAttribute("data-flagged", "true");
  await expect(advice).toContainText(
    "India Post Domestic: PayPal accepts it; it may not speed up the release. Faster: Delhivery India, DTDC India, Ekart logistics, BLUEDART",
  );
  // icon + text: the warning icon is decorative, the words carry the meaning
  await expect(advice.locator("svg[aria-hidden='true']").first()).toBeAttached();
  await expect(advice.getByTestId("carrier-caveat")).toHaveText(
    "Sandbox US account list; live and other-country accounts may differ",
  );
  // both tiers cite their list and date
  const toggles = advice.getByTestId("tier-source-toggle");
  await expect(toggles).toHaveCount(2);
  await toggles.first().click();
  await expect(advice.getByTestId("tier-source-panel").first()).toContainText(
    "PayPal tracking API: carriers",
  );
  await expect(advice.getByTestId("tier-source-panel").first()).toContainText("Recorded 2026-11-02");
  await toggles.nth(1).click();
  await expect(advice.getByTestId("tier-source-panel").nth(1)).toContainText('PayPal "Shipped by" list');
  await page.keyboard.press("Escape");
  // exactly one row action: File tracking (replaces "Why?" until tracking is filed)
  await expect(row.locator("[data-row-action]")).toHaveCount(1);
  await expect(row.getByTestId("file-tracking")).toHaveText("File tracking");
  await expect(row.getByTestId("file-tracking")).toHaveAttribute(
    "aria-label",
    "File tracking for $420.00 USD",
  );

  // approved carrier: no warning line
  const ok = page.locator(`[data-testid="payment-row"][data-hold="${delhivery.holdId}"]`);
  await expect(ok).toBeVisible();
  await expect(ok.getByTestId("route-advice")).toHaveCount(0);
  await expect(ok.getByTestId("file-tracking")).toBeVisible();

  await expect(page.locator("body")).not.toContainText("not approved");
  await axeClean(page, "dashboard-tracking");
  await capture(page, "en-dashboard-tracking", REVIEW_TRACKING);

  // HI
  await page.goto("/hi/payments");
  const hiRow = page.locator(`[data-testid="payment-row"][data-hold="${india.holdId}"]`);
  await expect(hiRow.getByTestId("route-advice")).toContainText(
    "PayPal इसे मानता है; इससे रिलीज़ शायद जल्दी न हो।",
  );
  await expect(hiRow.getByTestId("carrier-caveat")).toContainText("सैंडबॉक्स US खाते की सूची");
  await expect(hiRow.getByTestId("file-tracking")).toHaveText("ट्रैकिंग दर्ज करें");
  await axeClean(page, "dashboard-tracking-hi");
  await capture(page, "hi-dashboard-tracking", REVIEW_TRACKING, [360, 1440]);
});
