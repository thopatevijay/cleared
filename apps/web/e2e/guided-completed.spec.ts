// M3-04 E2E (local, PayPal stubbed from the recorded M0-04 trackers-batch 200 + read-back): a service hold's
// action slot is the guided Completed step. The PayPal Activity link points at the sandbox host
// (PAYPAL_ENV=sandbox in the local stack), the capture ID is shown with Copy, PayPal support's quote is
// verbatim. The secondary "Also record it with PayPal's API" always carries "Effect on release unconfirmed".
// The seller records it through the API first (review → fingerprint → approve by keyboard → the worker sends
// it): recorded, PayPal reads COMPLETED, and the estimate does NOT change. Then the seller confirms the web
// step: the estimate becomes the confirmed date + 7 days (estimated, help129) and the hold is filed.
// axe and 360–1440 px light/dark at each state; HI at 360/1440.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean } from "./support/holds.ts";
import { REVIEW_COMPLETED, seedService } from "./support/completed.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

const top = async (page: import("@playwright/test").Page) => {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
};

test("guided Completed step: API record (unconfirmed, estimate unchanged), then the web step sets +7 days", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seedService(ws, new Date(Date.now() - 2 * 24 * 3600 * 1000));
  await page.goto(`/en/holds/${s.holdId}#completed`);
  const slot = page.getByTestId("guided-completed");
  await expect(slot).toBeFocused({ timeout: 15_000 });

  // A: the guide on the sandbox host, the capture id, the support quote
  const link = slot.getByTestId("activity-link");
  await expect(link).toHaveAttribute("href", "https://www.sandbox.paypal.com/myaccount/activities/");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(slot.getByTestId("activity-host")).toHaveText("Opens www.sandbox.paypal.com");
  await expect(slot.getByTestId("capture-id")).toHaveText(s.captureId);
  await expect(slot.getByTestId("support-quote").first()).toContainText(
    '"Completed" in your Activity section',
  );
  // D: the secondary path is collapsed and always labelled
  const record = slot.getByTestId("record-completed");
  await expect(record.getByTestId("unconfirmed-badge")).toHaveText("Effect on release unconfirmed");
  await expect(record.getByTestId("record-toggle")).toHaveAttribute("aria-expanded", "false");
  const estBefore = await page.getByTestId("estimated-date").first().textContent();
  await axeClean(page, "completed-guide");
  await top(page);
  await capture(page, "en-completed-guide", REVIEW_COMPLETED);

  // D: open, review the exact payload + fingerprint, approve by keyboard
  await record.getByTestId("record-toggle").click();
  await expect(record).toContainText("This doesn't change your estimate; only the step above does.");
  await record.getByTestId("record-review-button").click();
  const review = record.getByTestId("record-review");
  await expect(review.getByTestId("fingerprint")).toBeVisible();
  await expect(record.getByTestId("record-payload")).toContainText("record_service_completed");
  await expect(record.getByTestId("record-payload")).toContainText(s.captureId);
  await expect(record.getByTestId("record-payload")).toContainText("COMPLETED");
  await expect(record.getByTestId("unconfirmed-badge")).toBeVisible();
  await axeClean(page, "record-review");
  await top(page);
  await capture(page, "en-completed-record-review", REVIEW_COMPLETED);
  await review.getByTestId("record-approve").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("record-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("It doesn't change your estimate");
  await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
  await axeClean(page, "record-confirm");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("record-send")).toBeFocused();
  await page.keyboard.press("Enter");

  // the worker sends it (stubbed M0-04 200 + read-back COMPLETED); the estimate is unchanged
  await expect(record.getByTestId("record-recorded")).toBeVisible({ timeout: 90_000 });
  await expect(record.getByTestId("record-recorded")).toContainText(
    "PayPal reads COMPLETED · debug_id f529566754294",
  );
  await expect(record.getByTestId("unconfirmed-badge")).toBeVisible();
  await expect(page.getByTestId("estimated-date").first()).toHaveText(estBefore ?? "");
  // the hold may be explained meanwhile (M3-02), but never filed by the API record
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", /^(open|explained)$/);
  await axeClean(page, "record-recorded");
  await top(page);
  await capture(page, "en-completed-recorded", REVIEW_COMPLETED);

  // B → C: the web step with today's date
  await expect(slot.getByTestId("completed-date")).toHaveAttribute("max", /\d{4}-\d{2}-\d{2}/);
  await slot.getByTestId("completed-submit").click();
  const done = slot.getByTestId("completed-done");
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(slot.getByTestId("completed-done-heading")).toBeFocused();
  await expect(page.getByTestId("completed-toast")).toContainText("Saved. Estimate: about");
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "filed");
  const est = page.getByTestId("estimated-date").first();
  await expect(est).toHaveAttribute("data-rule", "service_completed");
  await expect(est).toContainText("estimated");
  await expect(page.getByTestId("timeline")).toContainText("Marked Completed in PayPal by you");
  await expect(record.getByTestId("unconfirmed-badge")).toBeVisible();
  await axeClean(page, "completed-done");
  await top(page);
  await capture(page, "en-completed-done", REVIEW_COMPLETED);

  // HI
  await page.goto(`/hi/holds/${s.holdId}`);
  await expect(page.getByTestId("unconfirmed-badge")).toHaveText("रिलीज़ पर असर की पुष्टि नहीं");
  await axeClean(page, "hi-completed-done");
  await capture(page, "hi-completed-done", REVIEW_COMPLETED, [360, 1440]);
});

test("date validation: a future date is refused inline; nothing changes", async ({ page }) => {
  const ws = await demoWorkspace(page);
  const s = await seedService(ws, new Date(Date.now() - 2 * 24 * 3600 * 1000));
  await page.goto(`/en/holds/${s.holdId}`);
  const slot = page.getByTestId("guided-completed");
  await slot.getByTestId("completed-date").fill("2099-01-01");
  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByRole("alert")).toHaveText("Pick today or an earlier date.");
  await expect(slot.getByTestId("completed-date")).toHaveAttribute("aria-invalid", "true");
  // the hold may be explained meanwhile (M3-02), but never filed by the API record
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", /^(open|explained)$/);
  await axeClean(page, "completed-date-error");
  await top(page);
  await capture(page, "en-completed-date-error", REVIEW_COMPLETED, [360, 1440]);
});
