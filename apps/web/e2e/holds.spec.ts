// M3-01 E2E (local): the held-money inbox and the hold detail over a hold the worker derived from the
// recorded wallet-review capture (PENDING / PENDING_REVIEW). Inbox: total per currency, the row with its
// estimate and Source, the badged Sample scenarios; detail: why (rule quote + source), the full estimate,
// the action slot and timeline; PayPal's release (COMPLETED) shows "Released" and empties the inbox.
// Empty, loading, error and not-found states; axe (WCAG 2.2 A/AA) and 360 px on every screen; HI.
import { expect, test } from "@playwright/test";
import { capture, demoWorkspace, local } from "./support/disputes.ts";
import { axeClean, releaseHeld, REVIEW_EXPLAIN, REVIEW_HOLDS, seedHeld } from "./support/holds.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

test("empty, loading and error states; the samples always show", async ({ page }) => {
  test.setTimeout(300_000);
  await demoWorkspace(page);
  await page.goto("/en/holds");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Held money");
  await expect(page.getByRole("heading", { name: "No held money." })).toBeVisible();
  await expect(page.getByText("Every payment is with you or on its way.")).toBeVisible();
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
  // the full estimate cites both bounds: T2105 (24 h) and the Holds panel (3 business days)
  await expect(est.getByTestId("source-toggle")).toHaveCount(2);
  await est.getByTestId("source-toggle").nth(0).click();
  await est.getByTestId("source-toggle").nth(1).click();
  await expect(est.getByTestId("source-quote").nth(0)).toContainText(
    "PayPal reviews the transaction for up to 24 hours.",
  );
  await expect(est.getByTestId("source-quote").nth(1)).toContainText("normally takes up to 3 business days");
  await expect(est.getByTestId("source-link").nth(0)).toHaveAttribute("href", /transaction-event-codes/);
  // the recorded capture's estimate (Oct 2026) has passed: still held, with what to check
  await expect(detail.getByTestId("still-held")).toContainText("Still held after the estimate.");
  await expect(detail.getByTestId("advice-line")).toContainText("Don't ship yet");
  await expect(detail.getByTestId("action-slot")).toContainText("Nothing to do.");
  // M3-02: the worker explains the hold on `hold.opened` (open → explained)
  await expect(detail.getByTestId("explanation")).toBeVisible({ timeout: 60_000 });
  await expect(detail.locator('[aria-current="step"] [data-testid="step-label"]')).toHaveText("Explained");
  await expect(detail.locator('[data-mark="done"]')).toHaveCount(1);
  await expect(detail.locator('[data-mark="notReached"]')).toHaveCount(4);
  await axeClean(page, "hold-detail");
  await capture(page, "en-hold-detail", REVIEW_HOLDS);

  // offline: the last data stays, with the banner
  await page.context().setOffline(true);
  await expect(page.getByTestId("offline-banner")).toContainText("You're offline.");
  await expect(detail).toBeVisible();
  await capture(page, "en-hold-detail-offline", REVIEW_HOLDS);
  await page.context().setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);

  // HI
  await page.goto(`/hi/holds/${s.holdId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("रोका गया (hold): $64.00 USD");
  await expect(page.getByTestId("estimated-date")).toContainText("अनुमानित");
  await axeClean(page, "hold-detail-hi");
  await capture(page, "hi-hold-detail", REVIEW_HOLDS);
  await page.goto("/hi/holds");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("रोका गया पैसा (hold)");
  await capture(page, "hi-holds-inbox", REVIEW_HOLDS);

  // PayPal releases it: the detail shows Released, the inbox empties
  await releaseHeld(ws, s.captureId);
  await page.goto(`/en/holds/${s.holdId}`);
  await expect(page.getByTestId("hold-detail")).toHaveAttribute("data-state", "released", {
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Released: $64.00 USD");
  await expect(page.getByTestId("released")).toContainText("Released");
  await expect(page.getByTestId("was-held")).toContainText("PENDING_REVIEW");
  await expect(page.getByTestId("hold-detail").locator("header")).toContainText("COMPLETED");
  await expect(page.locator('[aria-current="step"] [data-testid="step-label"]')).toHaveText("Released");
  await expect(page.getByTestId("step-label")).toHaveText(["Held", "Released"]);
  await axeClean(page, "hold-released");
  await capture(page, "en-hold-released", REVIEW_HOLDS);
  await page.goto("/en/holds");
  await expect(page.getByRole("heading", { name: "No held money." })).toBeVisible();

  // not found (another workspace's or no such hold)
  await page.goto("/en/holds/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Hold not found")).toBeVisible();
  await axeClean(page, "hold-not-found");
  await capture(page, "en-hold-not-found", REVIEW_HOLDS);
});

test("inbox variants: dispute-linked, no-timeline and review holds; held total per currency", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const review = await seedHeld(ws);
  const dispute = await seedHeld(ws, { amount: "120.00", reason: "BUYER_COMPLAINT" });
  const echeck = await seedHeld(ws, { amount: "15.00", currency: "EUR", reason: "ECHECK" });
  await page.goto("/en/holds");
  await expect(page.getByTestId("holds-total")).toHaveText("€15.00 EUR and $184.00 USD held in 3 payments");
  const row = (id: string) => page.locator(`[data-testid="hold-row"][data-hold="${id}"]`);
  await expect(row(dispute.holdId)).toContainText("Held because the buyer opened a dispute");
  await expect(row(dispute.holdId).getByTestId("estimated-date")).toContainText(
    "Released when the dispute is resolved",
  );
  await expect(row(dispute.holdId)).not.toContainText("Free by");
  await expect(row(echeck.holdId).getByTestId("estimated-date")).toContainText(
    "PayPal gives no timeline for this reason",
  );
  await expect(row(review.holdId).getByTestId("estimated-date")).toContainText("estimated");
  await axeClean(page, "holds-variants");
  await capture(page, "en-holds-variants", REVIEW_HOLDS);
  await page.goto("/hi/holds");
  await capture(page, "hi-holds-variants", REVIEW_HOLDS);
});

test("M3-02 explanation: AI in EN, the HI toggle, the standard text and the pending state", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page);
  const s = await seedHeld(ws);
  await page.goto(`/en/holds/${s.holdId}`);
  const detail = page.getByTestId("hold-detail");
  // the worker explained the hold on `hold.opened` (explain_hold@v2: the recorded live answer)
  const explanation = detail.getByTestId("explanation");
  await expect(explanation).toHaveAttribute("data-origin", "ai", { timeout: 60_000 });
  await expect(explanation).toContainText("AI explanation");
  await expect(detail.getByTestId("explanation-summary")).toContainText(/USD\s64\.00/);
  await axeClean(page, "hold-explanation-en");
  await capture(page, "en-hold-explanation", REVIEW_EXPLAIN);
  // the toggle asks for Hindi: POST /api/holds/:id/explanation → hold.explain_requested → the worker
  await detail.getByTestId("explanation-locale").getByRole("button", { name: "हिन्दी" }).click();
  await expect(detail.getByTestId("explanation-summary")).toHaveAttribute("lang", "hi", { timeout: 60_000 });
  await expect(detail.getByTestId("explanation-summary")).toContainText(/USD\s64\.00/);
  await axeClean(page, "hold-explanation-hi-toggle");
  await capture(page, "en-hold-explanation-hi-toggle", REVIEW_EXPLAIN);
  // the Hindi UI shows the Hindi explanation by default
  await page.goto(`/hi/holds/${s.holdId}`);
  await expect(page.getByTestId("explanation")).toContainText("AI व्याख्या");
  await axeClean(page, "hold-explanation-hi");
  await capture(page, "hi-hold-explanation", REVIEW_EXPLAIN);

  // no recording for an eCheck hold: the model call fails, the standard text is shown and labelled
  const echeck = await seedHeld(ws, { amount: "15.00", currency: "EUR", reason: "ECHECK" });
  await page.goto(`/en/holds/${echeck.holdId}`);
  await expect(page.getByTestId("explanation")).toHaveAttribute("data-origin", "standard", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("explanation")).toContainText(
    "Standard explanation (no AI summary right now)",
  );
  await axeClean(page, "hold-explanation-standard");
  await capture(page, "en-hold-explanation-standard", REVIEW_EXPLAIN);

  // pending: the detail as the API returns it before the worker's write (hold `open`, no explanation yet)
  await page.route(`**/api/holds/${s.holdId}`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { hold: Record<string, unknown> };
    await route.fulfill({
      response: res,
      json: { ...body, hold: { ...body.hold, state: "open" }, explanations: [] },
    });
  });
  await page.goto(`/en/holds/${s.holdId}`);
  await expect(page.getByTestId("explanation-pending")).toContainText("usually under 30 seconds");
  await expect(page.locator('[aria-current="step"] [data-testid="step-label"]')).toHaveText("Held");
  await axeClean(page, "hold-explanation-pending");
  await capture(page, "en-hold-explanation-pending", REVIEW_EXPLAIN);
});
