// M2-09 E2E (local): dashboard.md elements 3b, 4, 5. With a seeded open dispute the summary reads
// "$120.00 USD in dispute" (no "—"); the dispute row shows the `dispute` badge, "Item not as described" and
// the due date; "Review and approve" opens dispute review with focus on the ApprovalCard; with no draft
// ready the button is absent. The "in dispute" fact applies ?filter=dispute (dispute rows only); when
// disputes fail to load the fact shows "—" with the inline band, and payments stay. axe + 360 px.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local, seed, sql } from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("dispute total, dispute row, Review and approve, filter, partial state", async ({ page }) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seed(ws);
  // an undisputed payment too, so the filter has something to hide
  await sql(
    "insert into payments (workspace_id, capture_id, amount, currency, status, source) values ($1, $2, '64.00', 'USD', 'COMPLETED', 'webhook')",
    [ws, `E2EPLAIN${s.captureId.slice(3, 12)}`],
  );
  await page.goto("/en/payments");
  await expect(page.locator('[data-testid="payment-row"]:not([data-dispute])')).toHaveCount(1);
  const summary = page.getByTestId("summary");
  await expect(summary).toContainText("$120.00 USD in dispute");
  await expect(summary).not.toContainText("— in dispute");
  const row = page.locator(`[data-testid="payment-row"][data-dispute="${s.paypalDisputeId}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("dispute-lines")).toContainText("In dispute");
  await expect(row.getByTestId("dispute-lines")).toContainText("WAITING_FOR_SELLER_RESPONSE");
  await expect(row.getByTestId("dispute-reason")).toHaveText("Item not as described");
  await expect(row.getByTestId("dispute-due")).toContainText("due");
  await expect(row).toContainText("Reply ready");
  await capture(page, "en-dashboard-dispute");

  // the "in dispute" fact filters the list to dispute rows; the chip clears it
  await summary.getByTestId("summary-dispute").click();
  await expect(page).toHaveURL(/[?&]filter=dispute/);
  await expect(page.getByTestId("dispute-filter-chip")).toBeVisible();
  const rows = page.getByTestId("payment-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-dispute", s.paypalDisputeId);
  await capture(page, "en-dashboard-dispute-filter");
  await page.getByTestId("dispute-filter-chip").getByRole("link").click();
  await expect(page).not.toHaveURL(/filter=dispute/);

  // "Review and approve" → dispute review with focus on the ApprovalCard
  await row.getByTestId("review-approve").click();
  await page.waitForURL(`**/en/disputes/${s.disputeRowId}#approval`);
  await expect(page.getByTestId("approval-card")).toBeFocused({ timeout: 15_000 });

  // no draft ready → no "Review and approve"
  const bare = await seed(ws, { draft: false });
  await page.goto("/en/payments");
  const bareRow = page.locator(`[data-testid="payment-row"][data-dispute="${bare.paypalDisputeId}"]`);
  await expect(bareRow).toBeVisible();
  await expect(bareRow.getByTestId("review-approve")).toHaveCount(0);
  await expect(summary).toContainText("$240.00 USD in dispute");

  // disputes fail to load: "—" and the inline band; payments stay
  await page.route("**/api/disputes", (route) =>
    route.fulfill({
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000501",
      },
      body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
    }),
  );
  await page.goto("/en/payments");
  await expect(page.getByTestId("disputes-band")).toContainText(
    "Couldn't load disputes. Payments are up to date.",
  );
  await expect(summary).toContainText("— in dispute");
  await expect(page.getByTestId("payment-row").first()).toBeVisible();
  await capture(page, "en-dashboard-disputes-failed");
  await page.unroute("**/api/disputes");

  // HI
  await page.goto("/hi/payments");
  await expect(summary).toContainText("$240.00 USD विवाद में");
  await expect(page.getByTestId("review-approve").first()).toHaveText("देखें और मंज़ूरी दें");
  await capture(page, "hi-dashboard-dispute");
});
