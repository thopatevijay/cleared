// M4-04: visits every route of the judge path (signed-in screens with seeded data, then the public pages
// in a context without a session) and runs `check` on each, at each width. Used by the target-size and
// reflow specs.
import type { Browser, Page } from "@playwright/test";
import { SCREENS, screenReady, type Journey, type Locale } from "./journey.ts";

export type Check = (page: Page, name: string) => Promise<void>;

async function at(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
}

/** Loads each screen at each width (a fresh load per width: width-dependent defaults are the device's). */
export async function walkAll(
  page: Page,
  browser: Browser,
  locale: Locale,
  j: Journey,
  widths: readonly number[],
  check: Check,
): Promise<void> {
  for (const s of SCREENS) {
    for (const width of widths) {
      await at(page, width);
      await page.goto(`/${locale}${s.path(j)}`);
      await screenReady(page, s.ready);
      await check(page, `${locale}-${s.name}-${String(width)}`);
    }
  }
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    for (const [name, path, ready] of [
      ["landing", "", "demo-cta"],
      ["signin-expired", "/signin/expired", ""],
      ["ack", j.ackPath, ""],
    ] as const) {
      for (const width of widths) {
        await at(visitor, width);
        await visitor.goto(`/${locale}${path}`);
        if (ready === "") await visitor.locator("main h1").first().waitFor();
        else await visitor.getByTestId(ready).waitFor();
        await check(visitor, `${locale}-${name}-${String(width)}`);
      }
    }
  } finally {
    await ctx.close();
  }
}
