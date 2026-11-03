// BL-01 6570499264 E2E (local; PayPal stubbed from the recorded M0-04 track 201): a real-shaped PENDING_REVIEW
// hold (derived by the worker from the recorded wallet-review capture) offers "What did you sell?". The
// seller marks it goods → "You marked this as goods", route advice (neutral copy) and the add_tracking
// ApprovalCard; approve by keyboard → the worker files it; the estimate stays PayPal's review rule ("Within
// 24 hours; up to 3 business days", never "after the courier confirms delivery") and the declaration locks.
// A second hold marked a service → the guided Completed step without the 7-day claim; confirming keeps
// PayPal's estimate. axe and 360–1440 px light/dark (ui-reviewer evidence in .review/BL-6570499264/).
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { capture, demoWorkspace, local, sql } from "./support/disputes.ts";
import { axeClean, seedHeld } from "./support/holds.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

const REVIEW = fileURLToPath(new URL("../../../.review/BL-6570499264/", import.meta.url));
const REVIEW_EST = "Within 24 hours; up to 3 business days";
const CLAIMS = [
  "Tracking can help release this",
  "Faster release expected",
  "faster release",
  "after the courier confirms delivery",
  "7 days after you mark the order Completed",
];

const top = async (page: Page) => {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
};

async function reviewHold(ws: string) {
  const s = await seedHeld(ws, { seenAt: new Date(Date.now() - 60 * 60 * 1000) });
  // the PayPal order the capture belongs to (the stub answers track for `E2EO…` orders)
  const orderId = `E2EO${s.captureId.slice(4)}`;
  await sql("update payments set order_id = $1 where id = $2", [orderId, s.paymentId]);
  return { ...s, orderId };
}

async function expectPayPalEstimate(page: Page) {
  const est = page.getByTestId("estimated-date").first();
  await expect(est).toHaveAttribute("data-rule", "payment_review");
  await expect(est).toContainText(REVIEW_EST);
}

async function expectNoClaims(page: Page) {
  const slot = page.getByTestId("action-slot");
  for (const c of CLAIMS) await expect(slot).not.toContainText(c);
}

test("goods: declare → route advice + File tracking → approve → filed; PayPal's review estimate stays", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await reviewHold(ws);
  await page.goto(`/en/holds/${s.holdId}`);
  const decl = page.getByTestId("declaration");
  await expect(decl).toHaveAttribute("data-kind", "none");
  await expect(decl).toContainText("What did you sell?");
  await expect(decl).toContainText("PayPal doesn't say.");
  await expect(page.getByTestId("approval-card")).toHaveCount(0);
  await expectPayPalEstimate(page);
  await axeClean(page, "declare-undeclared");
  await top(page);
  await capture(page, "en-declare-undeclared", REVIEW);

  // keyboard: the radios are a native group
  await decl.getByTestId("declare-goods").check();
  await decl.getByTestId("declare-save").click();
  await expect(decl).toHaveAttribute("data-kind", "goods");
  await expect(page.locator("#declaration-heading")).toBeFocused();
  await expect(decl.getByTestId("declared-line")).toHaveText("You marked this as goods");
  await expect(decl.getByTestId("declared-note")).toContainText("This is your answer, not PayPal's.");
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", /^(open|explained)$/);
  const card = page.getByTestId("approval-card");
  await expect(card).toHaveAttribute("data-kind", "add_tracking");
  await expect(page.getByTestId("route-advice-full")).toContainText("Approved carriers");
  await expect(page.getByTestId("tracking-hint")).toHaveCount(0);
  await expectPayPalEstimate(page);
  await expectNoClaims(page);
  await axeClean(page, "declared-goods");
  await top(page);
  await capture(page, "en-declared-goods", REVIEW);

  // File tracking: review the exact payload, approve by keyboard; the worker sends it (stubbed 201)
  await card.getByTestId("carrier-select").selectOption("IND_DELHIVERY");
  await card.getByTestId("tracking-number").fill("SPK123457");
  await card.getByTestId("tracking-review-button").click();
  const review = card.getByTestId("tracking-review");
  await expect(review).toContainText("add_tracking");
  await expect(review).toContainText(s.orderId);
  await expect(review).toContainText(s.captureId);
  await card.getByTestId("tracking-approve").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tracking-confirm")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("tracking-send")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tracking-filed")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("tracking-debug-id")).toContainText("debug_id f345140fb0d0d");
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "filed");
  // the hard rule: still PayPal's review estimate, no delivery-based estimate
  await expectPayPalEstimate(page);
  await expect(page.getByTestId("estimated-date").first()).not.toContainText("courier");
  await expect(decl.getByTestId("declaration-locked")).toBeVisible();
  await expect(decl.getByTestId("declaration-change")).toHaveCount(0);
  await expectNoClaims(page);
  await axeClean(page, "declared-goods-filed");
  await top(page);
  await capture(page, "en-declared-goods-filed", REVIEW);

  // the dashboard row says it's the seller's answer
  await page.goto("/en/payments");
  const row = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await expect(row.getByTestId("declared-line")).toHaveText("You marked this as goods");
  await expect(row).not.toContainText("Tracking can help release this");
});

test("service: declare → guided Completed without the 7-day claim; confirming keeps PayPal's estimate", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await reviewHold(ws);
  await page.goto(`/en/holds/${s.holdId}`);
  const decl = page.getByTestId("declaration");
  // change of mind before any approval: goods, then service
  await decl.getByTestId("declare-goods").check();
  await decl.getByTestId("declare-save").click();
  await expect(decl).toHaveAttribute("data-kind", "goods");
  await decl.getByTestId("declaration-change").click();
  await decl.getByTestId("declare-service").check();
  await decl.getByTestId("declare-save").click();
  await expect(decl).toHaveAttribute("data-kind", "service");
  await expect(decl.getByTestId("declared-line")).toHaveText("You marked this as a service");
  const slot = page.getByTestId("guided-completed");
  await expect(slot.getByTestId("completed-intro")).toContainText("won't change its estimate");
  await expect(page.locator('[data-testid="approval-card"][data-kind="add_tracking"]')).toHaveCount(0);
  await expectPayPalEstimate(page);
  await expectNoClaims(page);
  await axeClean(page, "declared-service");
  await top(page);
  await capture(page, "en-declared-service", REVIEW);

  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByTestId("completed-done")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("completed-toast")).toHaveText("Saved. Your estimate hasn't changed.");
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "filed");
  await expectPayPalEstimate(page);
  await expect(decl.getByTestId("declaration-locked")).toBeVisible();
  await axeClean(page, "declared-service-done");
  await top(page);
  await capture(page, "en-declared-service-done", REVIEW);

  // HI
  const t = await reviewHold(ws);
  await page.goto(`/hi/holds/${t.holdId}`);
  await expect(page.getByTestId("declaration")).toContainText("आपने क्या बेचा?");
  await axeClean(page, "hi-declare-undeclared");
  await capture(page, "hi-declare-undeclared", REVIEW, [360, 1440]);
  await page.getByTestId("declare-goods").check();
  await page.getByTestId("declare-save").click();
  await expect(page.getByTestId("declared-line")).toHaveText("आपने इसे सामान बताया है");
  await capture(page, "hi-declared-goods", REVIEW, [360, 1440]);
});

test("declaration states: checked, nothing chosen, saving, save failed, refused, offline, change/cancel, dashboard, focus", async ({
  page,
  context,
}) => {
  test.setTimeout(900_000);
  const W = [375, 768, 1440] as const;
  const ws = await demoWorkspace(page);
  const s = await reviewHold(ws);
  await page.goto(`/en/holds/${s.holdId}`);
  const decl = page.getByTestId("declaration");
  await expect(decl).toHaveAttribute("data-kind", "none");

  // nothing chosen
  await decl.getByTestId("declare-save").click();
  await expect(decl.getByTestId("declare-error")).toHaveText("Choose goods or a service.");
  await capture(page, "en-declare-nothing-chosen", REVIEW, W);

  // checked card + keyboard focus on the radio
  await decl.getByTestId("declare-goods").focus();
  await page.keyboard.press("Space");
  await expect(decl.getByTestId("declare-goods")).toBeChecked();
  await expect(decl.getByTestId("declare-error")).toHaveCount(0);
  await page.screenshot({ path: `${REVIEW}en-declare-focus-radio-1280-light.png` });
  await capture(page, "en-declare-checked", REVIEW, W);

  // saving (held response), then save failed (no answer), then refused (409)
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/holds/*/declaration", async (route) => {
    await held;
    await route.abort("failed");
  });
  await decl.getByTestId("declare-save").click();
  await expect(decl.getByTestId("declare-save")).toHaveText("Saving…");
  await expect(decl.getByTestId("declare-goods")).toBeDisabled();
  await capture(page, "en-declare-saving", REVIEW, W);
  release();
  await expect(decl.getByTestId("declare-error")).toContainText(
    "Couldn't save your answer. Nothing changed.",
  );
  await expect(decl.getByTestId("declare-error")).toContainText("Reference");
  await axeClean(page, "declare-save-failed");
  await capture(page, "en-declare-save-failed", REVIEW, W);
  await page.unroute("**/api/holds/*/declaration");
  await page.route("**/api/holds/*/declaration", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "declaration_locked",
          message: "locked",
          details: { refusal: "DECLARATION_LOCKED" },
          correlationId: "e2e-ref",
        },
      }),
    }),
  );
  await decl.getByTestId("declare-save").click();
  await expect(decl.getByTestId("declare-error")).toContainText(
    "so your answer is locked (DECLARATION_LOCKED)",
  );
  await capture(page, "en-declare-refused", REVIEW, W);
  await page.unroute("**/api/holds/*/declaration");

  // offline
  await context.setOffline(true);
  await expect(decl.getByTestId("declare-save")).toBeDisabled();
  await expect(decl).toContainText("You're offline. Reconnect to save this.");
  await expect(decl.getByTestId("declare-error")).toHaveCount(0);
  await capture(page, "en-declare-offline", REVIEW, W);
  await context.setOffline(false);
  await expect(decl.getByTestId("declare-save")).toBeEnabled();

  // saved, then Change reopens with Cancel; focus visible on Change
  await decl.getByTestId("declare-save").click();
  await expect(decl).toHaveAttribute("data-kind", "goods");
  await expect(page.getByTestId("ship-first")).toContainText("PayPal asks you not to ship");
  // focus moved to the heading; Tab reaches Change by keyboard (focus-visible)
  await expect(page.locator("#declaration-heading")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(decl.getByTestId("declaration-change")).toBeFocused();
  await page.screenshot({ path: `${REVIEW}en-declare-focus-change-1280-light.png` });
  await decl.getByTestId("declaration-change").click();
  await expect(decl.getByTestId("declaration-form")).toBeVisible();
  await expect(decl.getByRole("button", { name: "Cancel" })).toBeVisible();
  await axeClean(page, "declare-change");
  await capture(page, "en-declare-change", REVIEW, W);
  await decl.getByRole("button", { name: "Cancel" }).click();
  await expect(decl.getByTestId("declaration-form")).toHaveCount(0);

  // the dashboard row
  await page.goto("/en/payments");
  const row = page.locator(`[data-testid="payment-row"][data-hold="${s.holdId}"]`);
  await expect(row.getByTestId("declared-line")).toHaveText("You marked this as goods");
  await axeClean(page, "dashboard-declared");
  await capture(page, "en-dashboard-declared", REVIEW, W);

  // HI: the declared-service guide and the locked line after Completed (after the toast is gone)
  const t = await reviewHold(ws);
  await page.goto(`/hi/holds/${t.holdId}`);
  await page.getByTestId("declare-service").check();
  await page.getByTestId("declare-save").click();
  await expect(page.getByTestId("declaration")).toHaveAttribute("data-kind", "service");
  await capture(page, "hi-declared-service", REVIEW, [360, 1440]);
  await page.getByTestId("completed-submit").click();
  await expect(page.getByTestId("declaration-locked")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("completed-toast")).toHaveCount(0, { timeout: 15_000 });
  await capture(page, "hi-declared-service-done", REVIEW, [360, 1440]);
  await page.goto(`/en/holds/${t.holdId}`);
  await expect(page.getByTestId("declaration-locked")).toHaveText("Locked: you marked it Completed.");
  await capture(page, "en-declared-service-done-notoast", REVIEW, W);
});
