// M3-01 E2E (local): dashboard.md elements 3a, 7–10, 13. A PENDING_REVIEW capture (recorded wallet
// review; the worker derives the hold) shows a held row: `held` badge, PENDING_REVIEW, "Free by … ·
// estimated · Source" (no bare "~"), the Source disclosure with the rule's quote and link, "Don't ship
// yet" + Source, and exactly one row action, "Why?", which opens the hold detail with focus on the
// explanation section. The held total is per currency and counts only derived holds (a PENDING payment
// without a reason adds nothing); the Sample scenarios link ends the list and opens the badged
// explainers; no $700 row exists. axe (WCAG 2.2 A/AA) and 360–1440 px light/dark captures; HI.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean, REVIEW_HOLDS, seedHeld, seedReasonless } from "./support/holds.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("held row, estimate with Source, Don't ship yet, Why?, held total, samples link", async ({ page }) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seedHeld(ws);
  await seedReasonless(ws, "999.00");
  await page.goto("/en/payments");

  const summary = page.getByTestId("summary");
  await expect(summary.getByTestId("summary-held")).toHaveText("$64.00 USD held");
  await expect(summary).not.toContainText("999");

  const row = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Held");
  await expect(row).toContainText("PENDING_REVIEW");
  const est = row.getByTestId("estimated-date");
  await expect(est).toContainText(/Free by \d{1,2} \w{3} · estimated · Source/);
  await expect(est).toHaveAttribute(
    "aria-label",
    /^Estimated release .+, source PayPal transaction event codes/,
  );
  await expect(row).not.toContainText("~");
  // the Source disclosure: the rule's quote and link
  await expect(est.getByTestId("source-panel")).toBeHidden();
  await est.getByTestId("source-toggle").click();
  await expect(est.getByTestId("source-quote")).toHaveText(
    "A payment review hold protects against unauthorized fraud loss and for seller protection. PayPal reviews the transaction for up to 24 hours.",
  );
  await expect(est.getByTestId("source-link")).toHaveAttribute(
    "href",
    "https://developer.paypal.com/docs/transaction-search/transaction-event-codes/",
  );
  await page.keyboard.press("Escape");
  await expect(est.getByTestId("source-panel")).toBeHidden();
  // "Don't ship yet" rides on the payment_review rule's hold-panel source
  const advice = row.getByTestId("advice-line");
  await expect(advice).toContainText("Don't ship yet: PayPal is reviewing this payment");
  await advice.getByTestId("source-toggle").click();
  await expect(advice.getByTestId("source-quote")).toContainText("Don't ship until we tell you it's ok.");
  // exactly one row action
  await expect(
    row.locator('[data-testid="why"], [data-testid="add-proof"], [data-testid="review-approve"]'),
  ).toHaveCount(1);
  await expect(row.getByTestId("why")).toHaveText("Why?");
  // the reason-less PENDING payment is a row without held lines
  const plain = page.locator('[data-testid="payment-row"]:not([data-hold])');
  await expect(plain).toHaveCount(1);
  await expect(plain.getByTestId("held-lines")).toHaveCount(0);

  // samples link ends the list; no $700 row
  const link = page.getByTestId("samples-link");
  await expect(link).toHaveText("Sample scenarios: limitation, reserve, new-seller hold");
  await expect(page.getByTestId("payment-row")).toHaveCount(2);
  await expect(page.getByTestId("payments-list")).not.toContainText("700");
  await axeClean(page, "dashboard-held");
  await capture(page, "en-dashboard-held", REVIEW_HOLDS);

  await link.click();
  await page.waitForURL("**/en/holds#samples");
  await expect(page.getByTestId("sample")).toHaveCount(3);
  await expect(page.getByTestId("holds-total")).toHaveText("$64.00 USD held in 1 payment");

  // "Why?" → the hold detail with focus on the explanation section
  await page.goto("/en/payments");
  await row.getByTestId("why").click();
  await page.waitForURL(`**/en/holds/${s.holdId}#why`);
  await expect(page.getByTestId("why-section")).toBeFocused({ timeout: 15_000 });

  // HI
  await page.goto("/hi/payments");
  const hiRow = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await expect(hiRow.getByTestId("estimated-date")).toContainText("अनुमानित");
  await expect(hiRow.getByTestId("advice-line")).toContainText("अभी सामान न भेजें");
  await expect(page.getByTestId("samples-link")).toContainText("नमूना स्थितियाँ");
  await axeClean(page, "dashboard-held-hi");
  await capture(page, "hi-dashboard-held", REVIEW_HOLDS);
});
