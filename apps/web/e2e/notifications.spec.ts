// M3-08 E2E (local): the header bell's unread count, the panel (≥ 768 px) and the /notifications page
// (< 768 px), mark one / mark all read, an item opening its dispute (and marking it read), the HI copy,
// and the empty / error / loading states. axe (WCAG 2.2 AA tags) and no horizontal scroll at 360 / 375 /
// 768 / 1440 in light and dark; screenshots go to .review/M3-08/ for the ui-reviewer.
// The rows are written with the product's own repo and core rules (what the consumers write), on a dispute
// seeded from the recorded M2-07 draft; nothing calls PayPal.
import { fileURLToPath } from "node:url";
import {
  deadlineAlert,
  disputeOpenedNotification,
  holdOpenedNotification,
  WorkspaceIdSchema,
  type Instant,
} from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import { capture, demoWorkspace, local, seed, shots } from "./support/disputes.ts";
import { seedJourney } from "./support/journey.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: seeds rows in the local database");

const REVIEW = fileURLToPath(new URL("../../../.review/M3-08/", import.meta.url));
const usd = (amount: string) => ({ amount, currency: "USD" as const });

/** Three unread notifications: a hold, a dispute opened, and its T-24 deadline (newest). */
async function notifications(ws: string): Promise<{ disputeRowId: string }> {
  const s = await seed(ws, { dueDate: new Date(Date.now() + 18 * 3_600_000 + 600_000) });
  const db = createDb(databaseUrl());
  try {
    const repo = forWorkspace(db, WorkspaceIdSchema.parse(ws)).notifications;
    const due = new Date(Date.now() + 18 * 3_600_000 + 600_000).toISOString() as Instant;
    const alert = deadlineAlert({
      disputeRowId: s.disputeRowId,
      dueDate: due,
      open: true,
      now: new Date().toISOString() as Instant,
      amount: usd("120.00"),
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    });
    if (alert === null) throw new Error("no alert");
    await repo.insertOnce(
      holdOpenedNotification({
        holdId: s.paymentId,
        paymentId: s.paymentId,
        amount: usd("64.00"),
        reason: "PENDING_REVIEW",
      }),
    );
    await repo.insertOnce(
      disputeOpenedNotification({
        disputeRowId: s.disputeRowId,
        amount: usd("120.00"),
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        dueDate: due,
      }),
    );
    await repo.insertOnce(alert);
  } finally {
    await closeDb(db);
  }
  return { disputeRowId: s.disputeRowId };
}

const PANEL_WIDTHS = [768, 1440] as const;
const ERROR_BODY = { error: { code: "internal", message: "x", correlationId: "e2e-ref-1" } };
const bell = (page: Page) => page.getByTestId("notification-bell");
const items = (page: Page) => page.getByTestId("notification");

test("bell count, panel list, mark read, open an item (EN, ≥ 768 px)", async ({ page }) => {
  test.setTimeout(240_000);
  const ws = await demoWorkspace(page);
  const s = await notifications(ws);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/payments");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 3 unread");
  await expect(page.getByTestId("notification-count")).toHaveText("3");
  // sweep M5 (BL-01 6604837005 item 4): every signed-in page carries the bell, so the header and its tab
  // order match between pages
  for (const path of ["/en/holds", "/en/calendar"]) {
    await page.goto(path);
    await expect(bell(page), path).toHaveAccessibleName("Notifications, 3 unread");
  }
  await page.goto("/en/payments");

  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Notifications" })).toBeFocused();
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).first()).toContainText("Reply to the $120.00 USD dispute is due in 18 hours");
  await expect(panel).toContainText("A buyer opened a dispute on $120.00 USD: item not as described.");
  await expect(panel).toContainText("PayPal is holding $64.00 USD (PENDING_REVIEW).");
  await expect(panel.getByText("New", { exact: true })).toHaveCount(3);
  await capture(page, "en-panel", REVIEW, PANEL_WIDTHS);

  // mark one read: the count drops, the item loses its "New"
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole("button", { name: /^Mark as read: PayPal is holding/ }).click();
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
  await expect(page.locator('[data-testid="notification"][data-read="true"]')).toHaveCount(1);

  // Escape closes the panel and returns focus to the bell
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(bell(page)).toBeFocused();

  // selecting an item opens its dispute and marks it read
  await bell(page).click();
  await page.getByRole("link", { name: /New A buyer opened a dispute/ }).click();
  await page.waitForURL(`**/en/disputes/${s.disputeRowId}`);
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");

  // HI panel with an unread item ("नई", rail, the HI mark-read button)
  await page.goto("/hi/payments");
  await expect(bell(page)).toHaveAccessibleName("सूचनाएँ, 1 अपठित");
  await bell(page).click();
  const hiPanel = page.getByRole("dialog", { name: "सूचनाएँ" });
  await expect(hiPanel.getByText("नई", { exact: true })).toHaveCount(1);
  await expect(hiPanel.getByRole("button", { name: /^पढ़ा हुआ मानें: / })).toHaveCount(1);
  await capture(page, "hi-panel", REVIEW, PANEL_WIDTHS);

  // the panel's error state (compact ErrorPanel with Retry and Reference)
  await page.route("**/api/notifications*", (route) =>
    route.fulfill({ status: 500, json: ERROR_BODY, headers: { "x-correlation-id": "e2e-ref-1" } }),
  );
  await page.goto("/en/payments");
  await bell(page).click();
  const errPanel = page.getByRole("dialog", { name: "Notifications" });
  await expect(errPanel.getByTestId("error-panel")).toContainText("Couldn't load notifications");
  await expect(errPanel.getByTestId("error-panel")).toContainText("e2e-ref-1");
  await capture(page, "en-panel-error", REVIEW, PANEL_WIDTHS);

  // the panel's loading state (3 skeleton items)
  await page.unroute("**/api/notifications*");
  await page.route("**/api/notifications*", async (route) => {
    await new Promise((r) => setTimeout(r, 6_000));
    await route.continue();
  });
  await page.goto("/en/payments");
  await bell(page).click();
  await expect(page.getByRole("dialog").getByTestId("notifications-loading")).toBeVisible();
  if (shots) {
    for (const width of PANEL_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${REVIEW}en-panel-loading-${String(width)}-light.png` });
    }
  }
  await page.unroute("**/api/notifications*");
});

test("360 px: the bell opens /notifications; mark all as read; HI copy", async ({ page }) => {
  test.setTimeout(240_000);
  const ws = await demoWorkspace(page);
  await notifications(ws);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/en/payments");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 3 unread");
  await bell(page).click();
  await page.waitForURL("**/en/notifications");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notifications");
  await expect(items(page)).toHaveCount(3);
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await capture(page, "en-page", REVIEW);

  await page.goto("/hi/notifications");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("सूचनाएँ");
  await expect(items(page).first()).toContainText("वाले विवाद का जवाब 18 घंटे में देना है");
  await expect(page.getByText("नई", { exact: true })).toHaveCount(3);
  await expect(bell(page)).toHaveAccessibleName("सूचनाएँ, 3 अपठित");
  await capture(page, "hi-page", REVIEW);

  // partial: a failed mark-read leaves the item unread with an inline message
  await page.goto("/en/notifications");
  await page.route("**/api/notifications", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: ERROR_BODY })
      : route.continue(),
  );
  await page.getByRole("button", { name: /^Mark as read: PayPal is holding/ }).click();
  await expect(page.getByText("Couldn't mark as read.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(3);
  await capture(page, "en-partial", REVIEW);
  await page.unroute("**/api/notifications");

  // offline: the last list stays; mark-read is disabled with "You're offline"
  await page.reload();
  await expect(items(page)).toHaveCount(3);
  await page.context().setOffline(true);
  await expect(page.getByText("You're offline")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark all as read" })).toBeDisabled();
  await expect(items(page)).toHaveCount(3);
  await capture(page, "en-offline", REVIEW);
  await page.context().setOffline(false);

  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "All notifications marked as read" }),
  ).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  await expect(page.locator('[data-testid="notification"][data-read="false"]')).toHaveCount(0);
  await capture(page, "en-page-read", REVIEW);
});

test("empty, error and loading states", async ({ page }) => {
  test.setTimeout(240_000);
  await demoWorkspace(page);
  await page.goto("/en/notifications");
  await expect(page.getByTestId("empty-state")).toContainText(
    "We'll tell you here when PayPal holds money or a dispute needs a reply.",
  );
  await expect(bell(page)).toHaveAccessibleName("Notifications");
  await capture(page, "en-empty", REVIEW);

  await page.route("**/api/notifications*", (route) =>
    route.fulfill({ status: 500, json: ERROR_BODY, headers: { "x-correlation-id": "e2e-ref-1" } }),
  );
  await page.goto("/en/notifications");
  await expect(page.getByTestId("error-panel").first()).toContainText("Couldn't load notifications");
  await expect(page.getByTestId("error-panel").first()).toContainText("e2e-ref-1");
  await capture(page, "en-error", REVIEW);

  await page.unroute("**/api/notifications*");
  await page.route("**/api/notifications*", async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue();
  });
  await page.goto("/en/notifications");
  await expect(page.getByTestId("notifications-loading")).toBeVisible();
  if (shots) {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: `${REVIEW}en-loading-375-light.png`, fullPage: true });
  }
});

/** The single numeric column `n` of `sql` (`$1` = the workspace) in the local database. */
async function count(sql: string, ws: string): Promise<number> {
  const db = createDb(databaseUrl());
  try {
    const r = await db.$client.query<{ n: string }>(sql, [ws]);
    return Number(r.rows[0]?.n ?? 0);
  } finally {
    await closeDb(db);
  }
}

// BL-01 6604837005 item 5: the journey seed wrote the hold's notification under the payment id while the
// worker wrote its own under the hold id, so one hold showed twice. Both now share the dedupe key.
test("one hold, one notification: the journey seed and the worker's hold.opened share the dedupe key", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const j = await seedJourney(page, "en");
  await expect
    .poll(
      () =>
        count(
          "select count(*) as n from pgboss.job where name = 'hold.opened' and data->>'workspaceId' = $1 and state = 'completed'",
          j.ws,
        ),
      { timeout: 90_000, message: "the worker completes hold.opened (its notification consumer ran)" },
    )
    .toBeGreaterThan(0);
  const holdRows = "select count(*) as n from notifications where workspace_id = $1 and kind = 'hold_opened'";
  expect(await count(holdRows, j.ws)).toBe(1);
  await page.goto("/en/notifications");
  await expect(page.getByTestId("notification").filter({ hasText: "PayPal is holding" })).toHaveCount(1);
});
