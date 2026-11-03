// M1-07 skeleton E2E: landing → "Try as demo seller" → empty state → "Create a sandbox test payment" →
// a COMPLETED row "via webhook". Local: PayPal is the msw replay stub (playwright.config.ts). Deployed
// (E2E_BASE_URL): the real sandbox and PayPal's real webhook; the time from the click to the visible row
// is printed as `webhook_to_visible_ms=<n>`. Also: isolation (a second demo context sees nothing), axe on
// every page and state (zero serious/critical), and, locally, the ui-reviewer screenshots in .review/M1-07.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import hi from "../messages/hi.json" with { type: "json" };
import { firstViewOff, firstViewOn } from "./support/journey.ts";

const deployed = process.env["E2E_BASE_URL"] !== undefined;
const REVIEW = fileURLToPath(new URL("../../../.review/M1-07/", import.meta.url));
const ARRIVAL_BUDGET_MS = 120_000;
const messages = { en, hi } as const;
type Locale = keyof typeof messages;
const LOCALES: readonly Locale[] = deployed ? ["en"] : ["en", "hi"];
const shots = !deployed && process.env["E2E_SCREENSHOTS"] !== "0";

mkdirSync(`${REVIEW}axe`, { recursive: true });

async function axe(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  writeFileSync(`${REVIEW}axe/${name}.json`, JSON.stringify(result.violations, null, 2));
  const blocking = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact ?? "?"}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, `axe serious/critical on ${name}`).toEqual([]);
}

/** No horizontal scroll at the page's current width (review-checklist "375 clip check"). */
async function noHorizontalScroll(page: Page, name: string): Promise<void> {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `horizontal scroll on ${name}`).toBeLessThanOrEqual(cw);
}

/** Screenshots at 375/768/1440 × light/dark (+ the 360 clip check), axe in both themes. */
async function capture(page: Page, name: string): Promise<void> {
  if (!shots) {
    await axe(page, name);
    return;
  }
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [360, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      await noHorizontalScroll(page, `${name}-${String(width)}-${theme}`);
      if (width !== 360) {
        await page.screenshot({ path: `${REVIEW}${name}-${String(width)}-${theme}.png`, fullPage: true });
      }
      if (width === 375 || width === 1440) await axe(page, `${name}-${String(width)}-${theme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function startDemo(page: Page, locale: Locale): Promise<void> {
  await page.goto(`/${locale}`);
  await page.getByTestId("demo-cta").click();
  await page.waitForURL(`**/${locale}/payments`);
  await expect(page.getByRole("heading", { level: 1, name: messages[locale].dashboard.title })).toBeVisible();
}

async function isolationCheck(browser: Browser, locale: Locale): Promise<void> {
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await startDemo(other, locale);
  await expect(other.getByTestId("empty-state")).toBeVisible();
  await expect(other.getByTestId("payment-row")).toHaveCount(0);
  const api = (await (await other.request.get("/api/payments")).json()) as { total: number };
  expect(api.total).toBe(0);
  await ctx.close();
}

for (const locale of LOCALES) {
  test(`skeleton ${locale}: demo → test payment → COMPLETED via webhook; isolation; axe`, async ({
    page,
    browser,
  }) => {
    const m = messages[locale];
    await page.goto(`/${locale}`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { level: 1, name: m.landing.h1 })).toBeVisible();
    await axe(page, `flow-landing-${locale}`);

    await page.getByTestId("demo-cta").click();
    await page.waitForURL(`**/${locale}/payments`);
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByRole("button", { name: m.empty.ctaName })).toBeVisible();
    // M4-07: the demo retention note
    await expect(page.getByTestId("demo-retention-note")).toHaveText(m.dashboard.demoRetention);
    await axe(page, `flow-empty-${locale}`);

    const clicked = Date.now();
    await page.getByRole("button", { name: m.empty.ctaName }).click();
    const row = page.getByTestId("payment-row").and(page.locator('[data-status="COMPLETED"]'));
    await expect(row).toBeVisible({ timeout: ARRIVAL_BUDGET_MS });
    const ms = Date.now() - clicked;
    console.log(
      `webhook_to_visible_ms=${String(ms)} locale=${locale} mode=${deployed ? "deployed" : "local"}`,
    );
    expect(ms).toBeLessThan(ARRIVAL_BUDGET_MS);
    await expect(row.getByTestId("source-tag")).toHaveText(m.row.viaWebhook);
    await expect(row.getByText(m.status.completed, { exact: true })).toBeVisible();
    await expect(page.getByTestId("live-region")).toContainText(m.status.completed);
    await axe(page, `flow-success-${locale}`);

    await isolationCheck(browser, locale);
  });
}

test("without a session, the dashboard and audit pages redirect to the landing page (served over HTTP)", async ({
  request,
}) => {
  for (const path of ["/en/payments", "/hi/audit"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(new URL(res.headers()["location"] ?? "", "http://x").pathname).toBe(path.slice(0, 3));
  }
  const root = await request.get("/", { maxRedirects: 0 });
  expect([307, 308]).toContain(root.status());
  expect(root.headers()["location"]).toMatch(/\/(en|hi)$/);
  expect((await request.get("/api/payments")).status()).toBe(401);
});

test("Atkinson Hyperlegible Next renders tabular figures (BL-01 6527541216)", async ({ page }) => {
  await page.goto("/en");
  const widths = await page.evaluate(async () => {
    await document.fonts.ready;
    const measure = (text: string, tabular: boolean): number => {
      const s = document.createElement("span");
      s.style.cssText = `font-size:34px;font-weight:700;position:absolute;white-space:nowrap;${tabular ? "font-variant-numeric:tabular-nums" : ""}`;
      s.textContent = text;
      document.body.append(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    return {
      family: getComputedStyle(document.documentElement).fontFamily,
      proportional: [measure("1111111", false), measure("0000000", false)],
      tabular: [measure("1111111", true), measure("0000000", true)],
    };
  });
  console.log(`tnum_check=${JSON.stringify(widths)}`);
  expect(Math.abs((widths.tabular[0] ?? 0) - (widths.tabular[1] ?? 1))).toBeLessThan(0.5);
});

const HELD_ROW = {
  id: "5d0c6b1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e",
  captureId: "7KM64000HELD0001",
  amount: { value: "64.00", currency: "USD" },
  receivable: { value: "5326.08", currency: "INR" },
  status: "PENDING",
  statusReason: "PENDING_REVIEW",
  source: "webhook",
  updatedAt: "2026-10-30T08:32:00.000Z",
};

type Fulfil = Parameters<Parameters<Page["route"]>[1]>[0];
const hang = (): Promise<void> => new Promise<void>(() => undefined);
const errorReply =
  (status: number, retryAfter?: string) =>
  (r: Fulfil): Promise<void> =>
    r.fulfill({
      status,
      headers: {
        "x-correlation-id": "4c8e1f2a-6b3d-4e5f-9a0b-1c2d3e4f5a6b",
        ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      },
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "x", message: "x", details: null, correlationId: "x" } }),
    });

/** Fresh landing page with one API answered by `reply`, then `act` drives it into the state. */
async function landingState(
  page: Page,
  url: string,
  reply: (r: Fulfil) => Promise<void>,
  act: () => Promise<void>,
): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.goto(page.url().replace(/(\/(en|hi)).*$/, "$1"));
  await page.route(url, reply);
  await act();
}

test("screens and states for ui-reviewer (local)", async ({ browser }) => {
  test.skip(!shots, "screenshots are local-only");
  for (const locale of LOCALES) {
    const m = messages[locale];
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/${locale}`);
    await capture(page, `landing-${locale}`);

    await page.route("**/api/demo", (r) =>
      r.fulfill({
        status: 429,
        headers: { "retry-after": "3600", "x-correlation-id": "2f1c7a8e-0b9d-4c55-9a3e-7d1e2b3c4d5e" },
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "rate_limited", message: "busy", details: null, correlationId: "x" },
        }),
      }),
    );
    await page.getByTestId("demo-cta").click();
    await expect(page.getByText(m.landing.capBusy.replace("{minutes}", "60"))).toBeVisible();
    await capture(page, `landing-cap-${locale}`);
    await page.unroute("**/api/demo");

    await landingState(page, "**/api/demo", errorReply(429, "86400"), async () => {
      await page.getByTestId("demo-cta").click();
      await expect(page.getByText(m.landing.capIp.replace(/<\/?video>/g, ""))).toBeVisible();
    });
    await capture(page, `landing-cap-ip-${locale}`);
    await landingState(page, "**/api/demo", errorReply(500), async () => {
      await page.getByTestId("demo-cta").click();
      await expect(page.getByTestId("error-panel")).toBeVisible();
    });
    await capture(page, `landing-error-${locale}`);
    await landingState(page, "**/api/demo", hang, async () => {
      await page.getByTestId("demo-cta").click();
      await expect(page.getByTestId("demo-cta")).toHaveAttribute("aria-busy", "true");
    });
    await capture(page, `landing-creating-${locale}`);
    await landingState(page, "**/api/auth/magic-link", hang, async () => {
      await page.getByLabel(m.landing.emailLabel).fill("seller@example.test");
      await page.getByRole("button", { name: m.landing.signinCta }).click();
      await expect(page.getByRole("button", { name: m.landing.sending })).toBeVisible();
    });
    await capture(page, `landing-sending-${locale}`);
    await landingState(page, "**/api/auth/magic-link", errorReply(429, "600"), async () => {
      await page.getByLabel(m.landing.emailLabel).fill("seller@example.test");
      await page.getByRole("button", { name: m.landing.signinCta }).click();
      await expect(page.getByText(m.landing.tooMany.replace("{minutes}", "10"))).toBeVisible();
    });
    await capture(page, `landing-too-many-${locale}`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto(`/${locale}`);
    await ctx.setOffline(true);
    await expect(page.getByText(m.landing.offline)).toBeVisible();
    await expect(page.getByTestId("demo-cta")).toBeDisabled();
    await capture(page, `landing-offline-${locale}`);
    await ctx.setOffline(false);

    await page.goto(`/${locale}`);
    await page.route("**/api/auth/magic-link", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
    );
    await page.getByLabel(m.landing.emailLabel).fill("not-an-email");
    await page.getByRole("button", { name: m.landing.signinCta }).click();
    await expect(page.getByText(m.landing.invalidEmail)).toBeVisible();
    await capture(page, `landing-invalid-email-${locale}`);
    await page.getByLabel(m.landing.emailLabel).fill("seller@example.test");
    await page.getByRole("button", { name: m.landing.signinCta }).click();
    await expect(page.getByTestId("check-email")).toBeVisible();
    await capture(page, `landing-check-email-${locale}`);
    await page.unroute("**/api/auth/magic-link");

    await page.goto(`/${locale}/signin/expired`);
    await capture(page, `expired-${locale}`);

    await startDemo(page, locale);
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await capture(page, `dashboard-empty-${locale}`);

    await firstViewOff(page); // M4-08: the first view is server-rendered; render without it here
    await page.route("**/api/payments", () => new Promise<void>(() => undefined));
    await page.reload();
    await expect(page.getByTestId("loading")).toBeVisible();
    await page.waitForTimeout(3_500);
    await capture(page, `dashboard-loading-${locale}`);
    await page.unroute("**/api/payments");

    await page.route("**/api/payments", (r) =>
      r.fulfill({
        status: 500,
        headers: { "x-correlation-id": "9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5f" },
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", message: "x", details: null, correlationId: "x" },
        }),
      }),
    );
    await page.reload();
    await expect(page.getByTestId("error-panel")).toBeVisible();
    await expect(page.getByTestId("correlation-id")).toHaveText("9b2d4f6a-1c3e-4a5b-8d7f-0e1a2b3c4d5f");
    await capture(page, `dashboard-error-${locale}`);
    await page.unroute("**/api/payments");
    await firstViewOn(page);

    await page.route("**/api/payments", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { testPayments: { waiting: number } };
      body.testPayments.waiting = 1;
      await r.fulfill({ response: res, json: body });
    });
    await page.reload();
    await expect(page.getByTestId("waiting-row")).toBeVisible();
    await capture(page, `dashboard-waiting-${locale}`);
    await page.unroute("**/api/payments");

    await page.route("**/api/payments", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { testPayments: { usedToday: number } };
      body.testPayments.usedToday = 3;
      await r.fulfill({ response: res, json: body });
    });
    await page.reload();
    await expect(page.getByText(m.empty.capped)).toBeVisible();
    await capture(page, `dashboard-capped-${locale}`);
    await page.unroute("**/api/payments");

    // A held (PENDING) row needs a PayPal review hold, which the sandbox card flow can't produce on
    // demand: the row is the M1-01 capture shape with synthetic data from dashboard.md (Kofi Mensah,
    // $64.00 USD, PENDING_REVIEW), injected into this page's response only.
    await page.route("**/api/payments", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as { items: unknown[]; total: number; summary: { held: unknown[] } };
      body.items = [HELD_ROW];
      body.total = 1;
      body.summary.held = [{ value: "64.00", currency: "USD" }];
      await r.fulfill({ response: res, json: body });
    });
    await page.reload();
    await expect(page.getByTestId("payment-row").and(page.locator('[data-status="PENDING"]'))).toBeVisible();
    await capture(page, `dashboard-held-${locale}`);
    await page.unroute("**/api/payments");

    await page.reload();
    await page.getByRole("button", { name: m.empty.ctaName }).click();
    await expect(page.getByTestId("payment-row").and(page.locator('[data-status="COMPLETED"]'))).toBeVisible({
      timeout: ARRIVAL_BUDGET_MS,
    });
    await capture(page, `dashboard-success-${locale}`);

    await page.goto(`/${locale}/audit`);
    await capture(page, `audit-${locale}`);
    await ctx.close();
  }
});
