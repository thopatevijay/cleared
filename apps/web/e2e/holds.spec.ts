// M3-01 E2E (local): the held-money inbox and the hold detail over a hold the worker derived from the
// recorded wallet-review capture (PENDING / PENDING_REVIEW). Inbox: total per currency, the row with its
// estimate and Source, the badged Sample scenarios; detail: why (rule quote + source), the full estimate,
// the action slot and timeline; PayPal's release (COMPLETED) shows "Released" and empties the inbox.
// Empty, loading, error and not-found states; axe (WCAG 2.2 A/AA) and 360 px on every screen; HI.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean, releaseHeld, REVIEW_HOLDS, seedHeld } from "./support/holds.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("empty, loading and error states; the samples always show", async ({ page }) => {
  test.setTimeout(300_000);
  await demoWorkspace(page);
  await page.goto("/en/holds");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Held money");
  await expect(page.getByText("No held money. Every payment is with you or on its way.")).toBeVisible();
  const samples = page.getByTestId("sample");
  await expect(samples).toHaveCount(3);
  for (const s of await samples.all()) {
    await expect(s).toContainText("Sample scenario: sandbox can't produce this");
  }
  await axeClean(page, "holds-empty");
  await capture(page, "en-holds-empty", REVIEW_HOLDS);

  // loading: the request gets no answer until the captures are done
  await page.route("**/api/holds", () => undefined);
  await page.goto("/en/holds");
  await expect(page.getByTestId("loading")).toBeVisible();
  await expect(page.getByText("Loading held money…")).toBeVisible({ timeout: 10_000 });
  await axeClean(page, "holds-loading");
  await capture(page, "en-holds-loading", REVIEW_HOLDS);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // error, with the correlation id as the reference
  await page.route("**/api/holds", (route) =>
    route.fulfill({
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000301",
      },
      body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
    }),
  );
  await page.goto("/en/holds");
  await expect(page.getByText("Couldn't load held money")).toBeVisible();
  await expect(page.getByText("c0ffee00-5ce7-4d1e-9a7a-000000000301")).toBeVisible();
  await axeClean(page, "holds-error");
  await capture(page, "en-holds-error", REVIEW_HOLDS);
  await page.unroute("**/api/holds");
});

test("inbox and detail with a derived PENDING_REVIEW hold; PayPal's release", async ({ page }) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seedHeld(ws);
  await page.goto("/en/holds");
  await expect(page.getByTestId("holds-total")).toHaveText("$64.00 USD held in 1 payment");
  const row = page.locator(`[data-testid="hold-row"][data-hold="${s.holdId}"]`);
  await expect(row).toContainText("PENDING_REVIEW");
  await expect(row).toContainText("PayPal is reviewing this payment");
  await expect(row.getByTestId("estimated-date")).toContainText(/Free by \d{1,2} \w{3} · estimated · Source/);
  await axeClean(page, "holds-inbox");
  await capture(page, "en-holds-inbox", REVIEW_HOLDS);

  // detail
  await row.getByRole("link", { name: "Open the hold on $64.00 USD" }).click();
  await page.waitForURL(`**/en/holds/${s.holdId}`);
  const detail = page.getByTestId("hold-detail");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Held: $64.00 USD");
  await expect(detail.getByTestId("rule-quote")).toContainText(
    "PayPal reviews the transaction for up to 24 hours.",
  );
  const est = detail.getByTestId("estimated-date");
  await expect(est).toContainText("Within 24 hours; up to 3 business days · estimated");
  await expect(est).toContainText(/Free by \d{1,2} \w{3} · up to \d{1,2} \w{3}/);
  await est.getByTestId("source-toggle").click();
  await expect(est.getByTestId("source-quote")).toContainText(
    "PayPal reviews the transaction for up to 24 hours.",
  );
  await expect(est.getByTestId("source-link")).toHaveAttribute("href", /transaction-event-codes/);
  await expect(detail.getByTestId("advice-line")).toContainText("Don't ship yet");
  await expect(detail.getByTestId("action-slot")).toContainText("Nothing to do.");
  await expect(detail.locator('[aria-current="step"]')).toHaveText("Held");
  await axeClean(page, "hold-detail");
  await capture(page, "en-hold-detail", REVIEW_HOLDS);

  // HI
  await page.goto(`/hi/holds/${s.holdId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("रोका गया: $64.00 USD");
  await expect(page.getByTestId("estimated-date")).toContainText("अनुमानित");
  await axeClean(page, "hold-detail-hi");
  await capture(page, "hi-hold-detail", REVIEW_HOLDS);
  await page.goto("/hi/holds");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("रोका गया पैसा");
  await capture(page, "hi-holds-inbox", REVIEW_HOLDS);

  // PayPal releases it: the detail shows Released, the inbox empties
  await releaseHeld(ws, s.captureId);
  await page.goto(`/en/holds/${s.holdId}`);
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "released", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("released")).toContainText("Released");
  await expect(page.locator('[aria-current="step"]')).toHaveText("Released");
  await axeClean(page, "hold-released");
  await capture(page, "en-hold-released", REVIEW_HOLDS);
  await page.goto("/en/holds");
  await expect(page.getByText("No held money. Every payment is with you or on its way.")).toBeVisible();

  // not found (another workspace's or no such hold)
  await page.goto("/en/holds/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Hold not found")).toBeVisible();
  await axeClean(page, "hold-not-found");
  await capture(page, "en-hold-not-found", REVIEW_HOLDS);
});
