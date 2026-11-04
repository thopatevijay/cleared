// BL-01 6539398891 E2E (local, fixture-backed): when the draft's notes rely on a scope line the pack's check
// marks missing, the approval card warns the seller (seller-only, never sent) above what PayPal receives; the
// notes keep the line; after an edit the warning asks the seller to check the edited notes. EN and HI, at
// 360 / 375 / 768 / 1440 in light and dark with axe (ui-reviewer captures in .review/BL-scope-warning/).
import { fileURLToPath } from "node:url";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import { recordedNotes, seedScopeGap } from "../test/support/dispute-seed.ts";
import { capture, demoWorkspace, local, seed } from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: the msw stub stands in for PayPal");

const DIR = fileURLToPath(new URL("../../../.review/BL-scope-warning/", import.meta.url));

async function draftWithGap(page: Page, locale: "en" | "hi"): Promise<string> {
  const ws = await demoWorkspace(page, locale);
  const s = await seed(ws);
  const db = createDb(databaseUrl());
  try {
    await seedScopeGap(db, ws, s);
  } finally {
    await closeDb(db);
  }
  return `/${locale}/disputes/${s.disputeRowId}`;
}

test("the card warns that the reply admits a missing scope line (EN)", async ({ page }) => {
  await page.goto(await draftWithGap(page, "en"));
  const warning = page.getByTestId("scope-gap-warning");
  await expect(
    warning.getByRole("heading", {
      name: "This reply tells PayPal some agreed work isn't shown as delivered",
    }),
  ).toBeVisible();
  await expect(page.getByTestId("scope-gap")).toHaveText([
    "Missing: Provide the editable Adobe Illustrator (.ai) source file.",
  ]);
  await expect(warning).toContainText("Only you see this warning. It isn't sent to PayPal.");
  await expect(page.getByTestId("notes")).toHaveValue(recordedNotes());
  await expect(page.getByTestId("approve")).toBeEnabled();
  await capture(page, "en-scope-gap", DIR);

  await page.getByTestId("notes").fill("We delivered the logo files listed in the scope.");
  await expect(page.getByTestId("revise-status")).toContainText("New fingerprint", { timeout: 15_000 });
  await expect(
    warning.getByRole("heading", { name: "Check what your reply tells PayPal about agreed work" }),
  ).toBeVisible();
  await page.getByTestId("notes").blur();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await capture(page, "en-scope-gap-edited", DIR, [375]);
});

test("the same in HI", async ({ page }) => {
  await page.goto(await draftWithGap(page, "hi"));
  const warning = page.getByTestId("scope-gap-warning");
  await expect(warning).toContainText("यह चेतावनी सिर्फ़ आपको दिखती है।");
  await expect(page.getByTestId("scope-gap")).toHaveText([
    "नहीं मिला: Provide the editable Adobe Illustrator (.ai) source file.",
  ]);
  await capture(page, "hi-scope-gap", DIR);
});
