// M4-04 ui-reviewer captures (local only, opt-in: E2E_REVIEW=1). Every screen of the judge path in EN and
// HI at 360 / 375 / 768 / 1440 px, light and dark, with axe next to each shot (support/review.ts `capture`);
// HI also at 320 px; the empty, loading and error states at 375 and 1440 px; and focus states (a Tab stop
// on each screen). Written to .review/M4-04/ (gitignored).
import { mkdirSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import {
  failRequests,
  holdRequests,
  SCREENS,
  screenReady,
  seedJourney,
  type Locale,
} from "./support/journey.ts";
import { demoSeller, seedPayment } from "./support/pack-seed.ts";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { capture, local, reviewDir } from "./support/review.ts";

const DIR = reviewDir("M4-04");
test.skip(!local || process.env["E2E_REVIEW"] !== "1", "opt-in review captures (E2E_REVIEW=1)");

async function shot(page: Page, name: string, widths: readonly number[]): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.screenshot({ path: `${DIR}${name}-${String(width)}-light.png`, fullPage: true });
  }
}

for (const locale of ["en", "hi"] as const satisfies readonly Locale[]) {
  test(`review captures (${locale})`, async ({ page, browser }) => {
    test.setTimeout(1_800_000);
    mkdirSync(DIR, { recursive: true });
    const j = await seedJourney(page, locale);
    for (const s of SCREENS) {
      const path = `/${locale}${s.path(j)}`;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await screenReady(page, s.ready);
      await capture(page, `${locale}-${s.name}`, DIR);
      if (locale === "hi") {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto(path);
        await screenReady(page, s.ready);
        await shot(page, `hi-${s.name}`, [320]);
      }
      // a focus state: the first Tab stops after the skip link
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await screenReady(page, s.ready);
      for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
      await page.screenshot({ path: `${DIR}${locale}-${s.name}-focus-1440-light.png` });
      if (s.api === undefined) continue;
      const release = await holdRequests(page, s.api);
      await page.goto(path);
      await page
        .getByTestId(s.loading ?? "loading")
        .first()
        .waitFor();
      await shot(page, `${locale}-${s.name}-loading`, [375, 1440]);
      await release();
      const restore = await failRequests(page, s.api);
      await page.goto(path);
      await page.getByTestId("error-panel").first().waitFor();
      await shot(page, `${locale}-${s.name}-error`, [375, 1440]);
      await restore();
    }
    // the calendar's default view depends on the width it loads at: reload per width (List below 768)
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [360, 375, 768]) {
        await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
        await page.goto(`/${locale}/calendar`);
        await screenReady(page, "calendar-area");
        await page.screenshot({
          path: `${DIR}${locale}-calendar-${String(width)}-${theme}.png`,
          fullPage: true,
        });
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    // empty states: a new seller
    const ws = await demoSeller(page, locale);
    for (const [name, path] of [
      ["payments", "/payments"],
      ["holds", "/holds"],
      ["disputes", "/disputes"],
      ["calendar", "/calendar"],
      ["notifications", "/notifications"],
    ] as const) {
      await page.goto(`/${locale}${path}`);
      await screenReady(page, "empty-state");
      await shot(page, `${locale}-${name}-empty`, [375, 1440]);
    }
    // a new seller's audit log (its first entries) and an empty proof pack (no evidence yet)
    await page.goto(`/${locale}/audit`);
    await screenReady(page, "audit-list");
    await shot(page, `${locale}-audit-empty`, [375, 1440]);
    const db = createDb(databaseUrl());
    let emptyPack: string;
    try {
      ({ paymentId: emptyPack } = await seedPayment(db, ws, "45.00"));
    } finally {
      await closeDb(db);
    }
    await page.goto(`/${locale}/payments/${emptyPack}/pack`);
    await page.locator("[data-testid=intake][data-ready=true]").waitFor();
    await shot(page, `${locale}-pack-empty`, [375, 1440]);
    // public pages
    const ctx = await browser.newContext();
    const visitor = await ctx.newPage();
    for (const [name, path] of [
      ["landing", ""],
      ["signin-expired", "/signin/expired"],
      ["ack", j.ackPath],
    ] as const) {
      await visitor.goto(`/${locale}${path}`);
      await visitor.locator("main h1").first().waitFor();
      await capture(visitor, `${locale}-${name}`, DIR);
    }
    await ctx.close();
  });
}
