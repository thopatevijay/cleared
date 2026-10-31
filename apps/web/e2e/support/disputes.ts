// M2-09 local E2E support: a fresh demo workspace, the seeded dispute (test/support/dispute-seed.ts:
// recorded M2-07 draft, real compile and proposal), axe and the ui-reviewer captures (.review/M2-09/,
// gitignored), and the approve flow through the UI up to PayPal's mirrored outcome (the worker files the
// evidence against the msw stub's recorded responses; never the real sandbox).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { expect, type Page } from "@playwright/test";
import { seedDispute, type SeedOptions, type SeededDispute } from "../../test/support/dispute-seed.ts";

export const local = process.env["E2E_BASE_URL"] === undefined && process.env["E2E_LIVE"] !== "1";
export const shots = local && process.env["E2E_SCREENSHOTS"] !== "0";
export const REVIEW = fileURLToPath(new URL("../../../../.review/M2-09/", import.meta.url));
export const PAYOUT_EN = "Resolved; you keep the money (PayPal covered the case)";

export async function demoWorkspace(page: Page, locale: "en" | "hi" = "en"): Promise<string> {
  await page.context().clearCookies();
  await page.goto(`/${locale}`);
  await page.getByTestId("demo-cta").click();
  await page.waitForURL(`**/${locale}/payments`);
  const res = await page.request.get("/api/workspace");
  return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

export async function seed(ws: string, o: SeedOptions = {}): Promise<SeededDispute> {
  const db = createDb(databaseUrl());
  try {
    return await seedDispute(db, ws, o);
  } finally {
    await closeDb(db);
  }
}

/** Runs SQL against the local E2E database (state set-up for screens only). */
export async function sql(text: string, params: unknown[]): Promise<void> {
  const db = createDb(databaseUrl());
  try {
    await db.$client.query(text, params);
  } finally {
    await closeDb(db);
  }
}

export async function axe(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  mkdirSync(`${REVIEW}axe`, { recursive: true });
  writeFileSync(`${REVIEW}axe/${name}.json`, JSON.stringify(result.violations, null, 2));
  const blocking = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, `axe serious/critical on ${name}`).toEqual([]);
}

/** No horizontal scroll at this width. */
export async function fits(page: Page, label: string): Promise<void> {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `horizontal scroll on ${label}`).toBeLessThanOrEqual(cw);
}

/** 360 (the AC width) + 375 / 768 / 1440 in light and dark, with axe on each (ui-reviewer evidence). */
export async function capture(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [360, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await fits(page, `${name}-${String(width)}`);
      if (shots) {
        mkdirSync(REVIEW, { recursive: true });
        await page.screenshot({ path: `${REVIEW}${name}-${String(width)}-${theme}.png`, fullPage: true });
      }
      await axe(page, `${name}-${String(width)}-${theme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Keyboard-only approve on the open dispute page, then PayPal's states up to the mirrored outcome. */
export async function approveByKeyboard(page: Page): Promise<void> {
  const approve = page.getByTestId("approve");
  await expect(approve).toBeEnabled();
  await approve.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Go back" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("approve-send")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("filing-status")).toHaveAttribute(
    "data-state",
    /approved|executing|succeeded/,
    {
      timeout: 20_000,
    },
  );
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "succeeded", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("outcome-text")).toHaveText(PAYOUT_EN, { timeout: 90_000 });
}
