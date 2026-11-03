// M4-05 E2E (local, production build): the app-wide nonce CSP (proxy.ts, src/lib/security-headers.ts)
// breaks no page. Every signed-in page, the landing page and the Hindi locale load with zero
// `securitypolicyviolation` events, and the cash calendar still draws Bryntum's grid (loaded at runtime
// from /vendor, BL-01 6595246110) under a script-src without 'unsafe-eval' or 'strict-dynamic'.
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import { seedCash } from "../test/support/cash-seed.ts";
import { demoWorkspace, local, seed } from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

/**
 * The one refusal we expect: asn1.js (crypto-browserify, pulled into client chunks by @cleared/core's
 * barrel re-exporting node:crypto, BL-01) probes `vm.runInThisContext` inside a try/catch and falls
 * back to a plain function. Refusing that eval is the CSP working. Any other violation, and any eval
 * from /vendor/ (Bryntum), fails the test.
 */
const EXPECTED = /^script-src eval https?:\/\/[^/]+\/_next\/static\/chunks\/[^/]+\.js:\d+$/;

/** Records every CSP violation the page reports, from the first script on (minus EXPECTED). */
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

test("every page loads under the app-wide CSP with no violation", async ({ page }) => {
  const violations = await watchCsp(page);
  const ws = await demoWorkspace(page);
  const db = createDb(databaseUrl());
  let cash;
  try {
    cash = await seedCash(db, ws, new Date());
  } finally {
    await closeDb(db);
  }
  const d = await seed(ws);
  const pages = [
    "/en",
    "/en/payments",
    `/en/payments/${d.paymentId}`,
    `/en/payments/${d.paymentId}/pack`,
    "/en/disputes",
    `/en/disputes/${d.disputeRowId}`,
    "/en/holds",
    `/en/holds/${cash.review.holdId}`,
    "/en/notifications",
    "/en/audit",
    "/en/signin/expired",
    "/hi/payments",
  ];
  for (const path of pages) {
    const res = await page.goto(path);
    expect(res?.headers()["content-security-policy"], path).toContain("'nonce-");
    expect(res?.headers()["content-security-policy"], path).not.toContain("unsafe-eval");
    // The pages poll every 5 s, so the network never goes idle: wait for load, then one poll cycle.
    await page.waitForLoadState("load");
    await page.waitForTimeout(1_500);
    expect(await violations(), path).toEqual([]);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/calendar?view=month");
  await expect(page.locator(".cash-bryntum .b-calendar-cell[data-date]").first()).toBeAttached({
    timeout: 60_000,
  });
  await expect(page.locator(".cash-bryntum [data-event-id]").first()).toBeAttached({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
  expect(await violations(), "/en/calendar").toEqual([]);
});
