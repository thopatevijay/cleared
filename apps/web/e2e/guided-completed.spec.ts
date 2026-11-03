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
import { REVIEW_COMPLETED, seedRecord, seedService } from "./support/completed.ts";
import { firstViewOff, firstViewOn } from "./support/journey.ts";

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
  // "#completed" moves focus to the step's heading
  await expect(page.locator("#completed")).toBeFocused({ timeout: 15_000 });

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
  await expect(est).toContainText(/About \d{1,2} \w{3} · estimated/);
  await expect(est).not.toContainText("Free by");
  await expect(page.getByTestId("timeline")).toContainText("Marked Completed in PayPal by you");
  // the explanation written for the earlier rule ("no release date") no longer shows beside the estimate
  await expect(page.getByTestId("why-section")).not.toContainText("gives no release date");
  await expect(page.getByTestId("rule-quote")).toContainText("7 days after you confirm the order status");
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

const DAY = 24 * 3600 * 1000;

test("states: loading, error, not found, saving, save failed, offline, before-opened, dialog, API card states", async ({
  page,
  context,
}) => {
  test.setTimeout(900_000);
  const W = [375, 1440] as const;
  const ws = await demoWorkspace(page);
  const s = await seedService(ws, new Date(Date.now() - 2 * DAY));
  const url = `/en/holds/${s.holdId}`;
  const api = `**/api/holds/${s.holdId}`;
  const slot = page.getByTestId("guided-completed");

  // loading: the detail (and its slot) never answers (M4-08: without the server-rendered first view)
  await firstViewOff(page);
  await page.route(api, () => undefined);
  await page.goto(url);
  await expect(page.getByTestId("loading")).toBeVisible();
  await capture(page, "en-completed-loading", REVIEW_COMPLETED, W);
  await page.unroute(api);
  // error
  await page.route(api, (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "internal", message: "x", correlationId: "c0ffee00-e2e0-4000-8000-000000000000" },
      }),
    }),
  );
  await page.goto(url);
  await expect(page.getByRole("button", { name: /retry/i })).toBeVisible({ timeout: 15_000 });
  await capture(page, "en-completed-error", REVIEW_COMPLETED, W);
  await page.unroute(api);
  await firstViewOn(page);
  // not found (no such hold in this workspace)
  await page.goto("/en/holds/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Hold not found")).toBeVisible({ timeout: 15_000 });
  await capture(page, "en-completed-not-found", REVIEW_COMPLETED, W);

  // a date before the hold opened
  await page.goto(url);
  await expect(slot).toBeVisible({ timeout: 15_000 });
  await slot.getByTestId("completed-date").fill(new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10));
  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByRole("alert")).toContainText("PayPal started holding this payment that day");
  await axeClean(page, "completed-before-opened");
  await top(page);
  await capture(page, "en-completed-before-opened", REVIEW_COMPLETED, W);

  // save failed (network)
  await page.goto(url);
  await page.route(`${api}/completed`, (r) => r.abort());
  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByTestId("completed-error-ref")).not.toBeEmpty();
  await expect(slot.getByTestId("completed-error-text")).toHaveText(
    "Couldn't save your confirmation. Nothing changed. Try again.",
  );
  await axeClean(page, "completed-save-failed");
  await top(page);
  await capture(page, "en-completed-save-failed", REVIEW_COMPLETED, W);
  await page.unroute(`${api}/completed`);

  // offline: both writes disabled with the reason; the Activity link stays usable
  await page.goto(url);
  await expect(slot).toBeVisible({ timeout: 15_000 });
  await slot.getByTestId("record-toggle").click();
  await context.setOffline(true);
  await expect(slot.getByTestId("completed-submit")).toBeDisabled();
  await expect(slot.getByTestId("record-review-button")).toBeDisabled();
  await expect(slot).toContainText("You're offline. Reconnect to save this.");
  await expect(slot.getByTestId("activity-link")).toBeVisible();
  await top(page);
  await capture(page, "en-completed-offline", REVIEW_COMPLETED, W);
  await context.setOffline(false);

  // 44 px targets below 768 in the slot; the confirm dialog
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(url);
  await slot.getByTestId("record-toggle").click();
  await slot.getByRole("button", { name: "Why unconfirmed?" }).click();
  await slot.getByTestId("record-review-button").click();
  await expect(slot.getByTestId("record-approve")).toBeVisible();
  for (const name of ["Why unconfirmed?", "Copy full fingerprint", "Approve and record"]) {
    const box = await slot.getByRole("button", { name }).first().boundingBox();
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
  }
  const copy = await slot.getByTestId("copy-id").boundingBox();
  expect(copy?.height ?? 0).toBeGreaterThanOrEqual(44);
  await slot.getByTestId("record-approve").click();
  await expect(page.getByTestId("record-confirm")).toBeVisible();
  await expect(page.getByTestId("record-confirm").getByRole("button", { name: "Go back" })).toBeFocused();
  await axeClean(page, "record-dialog");
  await capture(page, "en-completed-record-dialog", REVIEW_COMPLETED, W);
  await page.keyboard.press("Escape");

  // saving (last on this hold: unrouting lets the held request through, which confirms it)
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await page.route(`${api}/completed`, () => undefined);
  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByTestId("completed-submit")).toHaveText("Saving…");
  await expect(slot.getByTestId("completed-date")).toHaveAttribute("readonly", "");
  await top(page);
  await capture(page, "en-completed-saving", REVIEW_COMPLETED, W);
  await page.unroute(`${api}/completed`);

  // the API card's recording / failed / unknown states (seeded; nothing moves them)
  for (const [state, code, testId] of [
    ["executing", null, "record-recording"],
    ["failed", "PAYPAL_REJECTED", "record-failed"],
    ["unknown", null, "record-unknown"],
  ] as const) {
    const h = await seedService(ws, new Date(Date.now() - 2 * DAY));
    await seedRecord(ws, h.captureId, state, code);
    await page.goto(`/en/holds/${h.holdId}`);
    await slot.getByTestId("record-toggle").click();
    await expect(slot.getByTestId(testId)).toBeVisible({ timeout: 15_000 });
    await expect(slot.getByTestId("unconfirmed-badge")).toBeVisible();
    await axeClean(page, `record-${state}`);
    await top(page);
    await capture(page, `en-completed-record-${state}`, REVIEW_COMPLETED, W);
  }
});
