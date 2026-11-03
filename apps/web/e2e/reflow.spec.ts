// M4-04 AC 3, reflow (WCAG 1.4.10): every route of the judge path, EN and HI, at 320 CSS px (400% zoom of
// 1280) and at 640 CSS px (200% zoom of 1280) has no horizontal scroll: the page's scroll width never
// exceeds its client width. Wide content (the calendar grid, tables) must wrap or scroll inside itself.
import { expect, test, type Page } from "@playwright/test";
import { seedJourney, type Locale } from "./support/journey.ts";
import { local } from "./support/review.ts";
import { walkAll } from "./support/walk.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: fixture replay");

async function noSideScroll(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect.soft(sw, `horizontal scroll on ${name}`).toBeLessThanOrEqual(cw);
}

for (const locale of ["en", "hi"] as const satisfies readonly Locale[]) {
  test(`reflow at 320 px and 200% zoom: every route (${locale})`, async ({ page, browser }) => {
    test.setTimeout(420_000);
    const j = await seedJourney(page, locale);
    await walkAll(page, browser, locale, j, [320, 640], noSideScroll);
  });
}
