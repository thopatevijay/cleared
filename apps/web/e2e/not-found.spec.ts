// BL-01 6649566240: unknown URLs get Cleared's own 404 (docs/design/screens/not-found.md): HTTP 404,
// <html lang> from the URL, one h1, a link home, no CSP violation, and axe (WCAG 2.0/2.1/2.2 A + AA) clean.
// Locally it also writes the ui-reviewer screenshots and axe JSON to .review/BL01-AUDIT/.
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import hi from "../messages/hi.json" with { type: "json" };
import { capture, local } from "./support/disputes.ts";

const DIR = fileURLToPath(new URL("../../../.review/BL01-AUDIT/", import.meta.url));
const messages = { en, hi } as const;

/** The one refusal csp.spec.ts expects too: asn1.js probing eval inside a try/catch (the CSP working). */
const EXPECTED = /^script-src eval https?:\/\/[^/]+\/_next\/static\/chunks\/[^/]+\.js:\d+$/;

/** Records every CSP violation from the first script on (minus EXPECTED). */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${String(e.lineNumber)}`);
    });
  });
  return async () =>
    (await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).filter(
      (v) => !EXPECTED.test(v),
    );
}

for (const locale of ["en", "hi"] as const) {
  test(`unknown URL under /${locale}: branded 404, lang set, link home, CSP clean, axe`, async ({ page }) => {
    const m = messages[locale].notFound;
    const violations = await watchCsp(page);
    for (const path of [`/${locale}/does-not-exist`, `/${locale}/no/such/page`]) {
      await page.context().clearCookies();
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(m.title);
      await expect(page).toHaveTitle(m.metaTitle);
      const home = page.getByRole("link", { name: m.home });
      await expect(home).toHaveAttribute("href", `/${locale}`);
      await page.waitForLoadState("load");
      await page.waitForTimeout(1_000);
      expect(await violations(), path).toEqual([]);
    }
    await page.goto(`/${locale}/does-not-exist`);
    await capture(page, `not-found-${locale}`, DIR);
    await page.getByRole("link", { name: m.home }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}$`));
  });
}

test("a path the proxy does not localize gets the root fallback 404 in English", async ({ page }) => {
  const res = await page.goto("/no-such-file.php");
  expect(res?.status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.notFound.title);
  await expect(page.getByRole("link", { name: en.notFound.home })).toHaveAttribute("href", "/en");
});

test("the ack page loads no browser Sentry (its connect-src is 'self'); other pages still do", async ({
  page,
}) => {
  test.skip(!local, "local only");
  const violations = await watchCsp(page);
  const sentry = (): Promise<boolean> =>
    page.evaluate(() => (globalThis as { __SENTRY__?: unknown }).__SENTRY__ !== undefined);
  await page.goto("/en");
  await page.waitForLoadState("load");
  await expect.poll(sentry).toBe(true);
  for (const locale of ["en", "hi"] as const) {
    await page.goto(`/${locale}/ack/not-a-real-token`);
    await page.waitForLoadState("load");
    await page.waitForTimeout(1_500);
    expect(await sentry(), locale).toBe(false);
    expect(await violations(), locale).toEqual([]);
    await capture(page, `ack-${locale}`, DIR);
  }
});
