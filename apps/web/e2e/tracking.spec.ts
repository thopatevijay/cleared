// M3-03 E2E (local, PayPal stubbed from the recorded M0-04 track 201): "File tracking" on a goods hold row
// opens the hold detail with focus on the `add_tracking` ApprovalCard, prefilled from the shipment
// evidence. The seller switches to an approved carrier (route advice), reviews the exact payload and its
// fingerprint (editing makes a new one), approves by keyboard, and the worker files it: "Tracking filed",
// the estimate becomes "About 24 hours after the courier confirms delivery" with no date, and the route
// advice and "File tracking" are gone (detail and dashboard). axe, 360–1440 px light/dark.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean } from "./support/holds.ts";
import { REVIEW_TRACKING, seedGoods } from "./support/tracking.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("File tracking → ApprovalCard → approve → filed; advice and button gone", async ({ page }) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seedGoods(ws, {
    amount: "420.00",
    shipment: { carrier: "India Post", tracking_number: "EE123456789IN" },
  });
  await page.goto("/en/payments");
  const row = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await row.getByTestId("file-tracking").click();
  await page.waitForURL(`**/en/holds/${s.holdId}#tracking`);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeFocused({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-kind", "add_tracking");

  // route advice on the detail: chosen carrier + tier badge, the approved alternatives as a list
  const full = page.getByTestId("route-advice-full");
  await expect(full.getByTestId("tier-badge")).toHaveAttribute("data-tier", "accepted");
  await expect(full.getByTestId("tier-badge")).toHaveText("Accepted carrier");
  await expect(full.getByTestId("alternatives").locator("li").first()).toContainText("IND_DELHIVERY");
  await expect(full.getByTestId("carrier-caveat")).toBeVisible();
  // prefilled from the shipment evidence
  await expect(card.getByTestId("carrier-select")).toHaveValue("INDIA_POST");
  await expect(card.getByTestId("tracking-number")).toHaveValue("EE123456789IN");
  await axeClean(page, "tracking-form");
  await capture(page, "en-hold-tracking-form", REVIEW_TRACKING);

  // follow the advice: Delhivery; review shows exactly what goes to PayPal
  await card.getByTestId("carrier-select").selectOption("IND_DELHIVERY");
  await card.getByTestId("tracking-number").fill("SPK123456");
  await card.getByTestId("tracking-review-button").click();
  const review = card.getByTestId("tracking-review");
  await expect(review).toContainText("IND_DELHIVERY");
  await expect(review.getByTestId("tier-badge")).toHaveAttribute("data-tier", "approved");
  await expect(review.getByTestId("review-number")).toHaveText("SPK123456");
  await expect(review).toContainText(s.orderId);
  await expect(review).toContainText(s.captureId);
  const fp1 = await review.getByTestId("tracking-fingerprint").textContent();
  // editing a field creates a new fingerprint
  await review.getByTestId("tracking-edit").click();
  await card.getByTestId("tracking-number").fill("SPK123457");
  await card.getByTestId("tracking-review-button").click();
  const fp2 = await card.getByTestId("tracking-fingerprint").textContent();
  expect(fp2).not.toEqual(fp1);
  await expect(page.getByTestId("route-advice-full").getByTestId("tier-badge")).toHaveAttribute(
    "data-tier",
    "approved",
  );
  await axeClean(page, "tracking-review");
  await capture(page, "en-hold-tracking-review", REVIEW_TRACKING);

  // approve by keyboard: initial focus "Go back", Tab → Send
  await card.getByTestId("tracking-approve").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("tracking-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
  await axeClean(page, "tracking-confirm");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("tracking-send")).toBeFocused();
  await page.keyboard.press("Enter");

  // the worker files it (stubbed PayPal 201): filed, estimate with no invented date
  await expect(page.getByTestId("tracking-filed")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("tracking-filed")).toContainText("Tracking filed");
  await expect(page.getByTestId("tracking-filed")).toContainText("SPK123457");
  const est = page.getByTestId("estimated-date");
  await expect(est).toHaveAttribute("data-rule", "goods_delivered");
  await expect(est).toContainText("About 24 hours after the courier confirms delivery");
  await expect(est.getByTestId("free-by")).toHaveCount(0);
  await expect(page.getByTestId("route-advice-full")).toHaveCount(0);
  await expect(page.getByTestId("tracking-form")).toHaveCount(0);
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "filed");
  await axeClean(page, "tracking-filed");
  await capture(page, "en-hold-tracking-filed", REVIEW_TRACKING);

  // the dashboard row: no advice line, no File tracking; "Why?" is back
  await page.goto("/en/payments");
  const after = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await expect(after).toBeVisible();
  await expect(after.getByTestId("route-advice")).toHaveCount(0);
  await expect(after.getByTestId("file-tracking")).toHaveCount(0);
  await expect(after.getByTestId("why")).toBeVisible();
});
