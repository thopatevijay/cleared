// M2-05 dashboard elements 3c, 6 and 16 (dashboard.md), local only. The new payment comes through the
// real path (sandbox test payment → recorded PayPal exchange → webhook → capture sync, which now creates
// the pack); checked packs are seeded as M2-04 leaves them.
import { closeDb, createDb, databaseUrl, type Db } from "@cleared/db";
import { expect, test } from "@playwright/test";
import { demoSeller, LOGO_LINES, seedChecked } from "./support/pack-seed.ts";
import { capture, local } from "./support/review.ts";

let db: Db;
test.beforeAll(() => {
  db = createDb(databaseUrl());
});
test.afterAll(async () => {
  await closeDb(db);
});
test.beforeEach(() => {
  test.skip(!local, "seeds the local database");
});

const MET = LOGO_LINES.filter((l) => l.verdict === "met");
const MET_ONLY = [...MET, ...MET.map((l) => ({ ...l, line: `${l.line} Delivered as final files.` }))];

test("AC 9: the summary counts packs checked with no missing verdict; clicking applies ?filter=proof-ready", async ({
  page,
}) => {
  const ws = await demoSeller(page);
  const ready = await seedChecked(db, ws, MET_ONLY);
  await seedChecked(db, ws, LOGO_LINES); // has a `missing` line: not proof-ready
  await page.goto("/en/payments");
  const fact = page.getByTestId("summary-proof-ready");
  await expect(fact).toHaveText("1 payment proof-ready");
  await expect(page.getByTestId("payment-row")).toHaveCount(2);
  await capture(page, "en-dashboard-packs");

  await fact.click();
  await expect(page).toHaveURL(/\/en\/payments\?filter=proof-ready$/);
  await expect(page.getByTestId("filter-chip")).toBeVisible();
  await expect(page.getByTestId("payment-row")).toHaveCount(1);
  await expect(page.getByTestId("payment-link")).toHaveAttribute(
    "href",
    `/en/payments/${ready.paymentId}/pack`,
  );
  await expect(page.getByTestId("pack-line")).toHaveText(
    // two sources: the brief (where the lines were agreed) and the chat (what shows them delivered)
    "Proof pack: scope met · delivery met · client sign-off pending · 2 sources",
  );
  await capture(page, "en-dashboard-filtered");
  await page.getByRole("link", { name: "Show all payments" }).click();
  await expect(page).toHaveURL(/\/en\/payments$/);
  await expect(page.getByTestId("payment-row")).toHaveCount(2);
});

test("AC 11: a new payment with an empty pack shows Add proof → the pack page with focus in the intake; gone once it has evidence", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await demoSeller(page);
  await page.getByTestId("empty-state").getByRole("button").click(); // "Create a sandbox test payment"
  const row = page.getByTestId("payment-row");
  await expect(row).toHaveCount(1, { timeout: 120_000 });
  await expect(row.getByTestId("new-payment")).toContainText(
    "New payment from a buyer. Add proof so it's ready if PayPal asks.",
  );
  await capture(page, "en-dashboard-new-payment");

  await row.getByTestId("add-proof").click();
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  await expect(page).toHaveURL(/\/en\/payments\/[0-9a-f-]+\/pack\?intake=1$/);
  await expect(page.locator("#intake-heading")).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.closest("[data-testid=intake]") !== null)).toBe(
    true,
  );
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByTestId("intake-text")).toBeVisible(); // the 375 px panel opened for "Add proof"
  await page.getByTestId("intake-text").fill("Asha: the logo files are attached, thanks!");
  await page.getByTestId("intake-add").click();
  await expect(page.getByTestId("intake-added")).toContainText("Evidence added");

  await page.goto("/en/payments");
  await expect(page.getByTestId("payment-row")).toHaveCount(1);
  await expect(page.getByTestId("add-proof")).toHaveCount(0);
});
