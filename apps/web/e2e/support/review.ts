// M2-05 review evidence (local only): axe with zero serious/critical findings, no horizontal scroll, and
// screenshots at 360 / 375 / 768 / 1440 in light and dark under .review/<ticket>/ (gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { WCAG_A_AA, withoutVendorLabelInName } from "./wcag.ts";

export const local = process.env["E2E_BASE_URL"] === undefined && process.env["E2E_LIVE"] !== "1";
export const shots = local && process.env["E2E_SCREENSHOTS"] !== "0";
export const REVIEW = fileURLToPath(new URL("../../../../.review/M2-05/", import.meta.url));

/** The review directory of another ticket (M3-06 on): `.review/<ticket>/`. */
export const reviewDir = (ticket: string): string =>
  fileURLToPath(new URL(`../../../../.review/${ticket}/`, import.meta.url));

/**
 * `soft` (M4-04's matrix): record the failure and carry on, so one run lists every finding. Returns the
 * number of violations per impact band.
 */
export async function axe(
  page: Page,
  name: string,
  dir: string = REVIEW,
  soft = false,
): Promise<{ serious: number; moderate: number; minor: number }> {
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_A_AA)
    .analyze();
  mkdirSync(`${dir}axe`, { recursive: true });
  writeFileSync(`${dir}axe/${name}.json`, JSON.stringify(result.violations, null, 2));
  const blocking = withoutVendorLabelInName(result.violations)
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  (soft ? expect.soft : expect)(blocking, `axe serious/critical on ${name}`).toEqual([]);
  const count = (impact: string) => result.violations.filter((v) => v.impact === impact).length;
  return { serious: blocking.length, moderate: count("moderate"), minor: count("minor") };
}

async function noSideScroll(page: Page, name: string): Promise<void> {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `horizontal scroll on ${name}`).toBeLessThanOrEqual(cw);
}

/**
 * Every width and theme: no horizontal scroll and axe clean. Screenshots only when `shots`; without them
 * the checks still run at 360 px and 1440 px in light.
 */
export async function capture(page: Page, name: string, dir: string = REVIEW): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const themes = shots ? (["light", "dark"] as const) : (["light"] as const);
  const widths = shots ? [360, 375, 768, 1440] : [360, 1440];
  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      // from the top: a scrolled page puts targets under the sticky header, which axe reads as obscured
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await noSideScroll(page, `${name}-${String(width)}`);
      if (shots) {
        await page.screenshot({ path: `${dir}${name}-${String(width)}-${theme}.png`, fullPage: true });
      }
      await axe(page, `${name}-${String(width)}-${theme}`, dir);
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}
