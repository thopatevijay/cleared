// M3-05 E2E (local): the cash calendar over a seeded workspace with every kind (test/support/cash-seed.ts).
// Month view (Bryntum) at 1440 with the kind colours and day totals; the list view at 360 (the default
// below 768 px) without horizontal scroll; keyboard: Tab reaches every event, Enter / Space open the hold
// or the dispute; axe (every WCAG 2.2 A/AA rule, any impact) on both; the text-alternative table lists
// every event in the range. All-day days stay on their date in browser zones behind and ahead of the
// workspace zone (BL-01 6490771972). Empty, loading and error states. No request leaves localhost (the
// trial's GTM snippet and bryntum.com/verify, BL-01 6491378837). Review captures go to .review/M3-05/.
import { fileURLToPath } from "node:url";
import { CashCalendarResponseSchema, type CashCalendarResponse } from "@cleared/core";
import { closeDb, createDb, databaseUrl } from "@cleared/db";
import { expect, test, type Browser, type Cookie, type Page } from "@playwright/test";
import { seedCash } from "../test/support/cash-seed.ts";
import { capture, demoWorkspace, local, sql } from "./support/disputes.ts";
import { axeClean } from "./support/holds.ts";

const REVIEW_CAL = fileURLToPath(new URL("../../../.review/M3-05/", import.meta.url));

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only");

async function seeded(page: Page): Promise<{ ws: string; cal: CashCalendarResponse }> {
  const ws = await demoWorkspace(page);
  const db = createDb(databaseUrl());
  try {
    await seedCash(db, ws, new Date());
  } finally {
    await closeDb(db);
  }
  const res = await page.request.get("/api/cash-calendar");
  return { ws, cal: CashCalendarResponseSchema.parse(await res.json()) };
}

/** Every request that leaves localhost (the trial's GTM / verify calls would show here). */
function external(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname) && u.protocol !== "data:") out.push(r.url());
  });
  return out;
}

const events = (page: Page) => page.locator(".cash-bryntum [data-event-id]");

test("month view at 1440: every event, kind colours, day totals, table, axe, no third-party request", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const calls = external(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { cal } = await seeded(page);
  expect(cal.events.map((e) => e.kind).sort()).toEqual([
    "dispute_deadline",
    "estimated_release",
    "estimated_release",
    "released",
    "service_completed_due",
  ]);
  await page.goto("/en/calendar");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cash calendar");
  await expect(page.getByTestId("held-now")).toHaveText("€15.50 EUR + $264.00 USD held now");
  await expect(page.getByTestId("calendar-area")).toHaveAttribute("data-view", "month");
  await expect(events(page)).toHaveCount(cal.events.length, { timeout: 60_000 });
  for (const e of cal.events) {
    const el = page.locator(`.cash-bryntum [data-event-id="${e.id}"]`);
    await expect(el).toHaveClass(new RegExp(`cash-ev--${e.kind}`));
    // all-day: the event sits in its own day's cell
    await expect(
      page.locator(`.b-calendar-cell[data-date="${e.date}"] [data-event-id="${e.id}"]`),
    ).toHaveCount(1);
  }
  await expect(events(page).filter({ hasText: "$64.00 USD · estimated" })).toHaveCount(1);
  await expect(events(page).filter({ hasText: "Reply due · $120.00 USD" })).toHaveCount(1);
  await expect(events(page).filter({ hasText: "$420.00 USD released" })).toHaveCount(1);
  await expect(events(page).filter({ hasText: "Completed + 7 days · estimated" })).toHaveCount(1);
  const review = cal.events.find((e) => e.amount.value === "64.00");
  await expect(
    page.locator(`.b-calendar-cell[data-date="${review?.date ?? ""}"] .cash-day-total`),
  ).toHaveText("€15.50 EUR estimated · $64.00 USD estimated");
  await expect(page.getByRole("button", { name: "Previous month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next month" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();

  // the text alternative lists every event in the range, with its source or "PayPal's date"
  const rows = page.getByTestId("cash-table-row");
  await expect(rows).toHaveCount(cal.events.length);
  await expect(page.getByRole("table", { name: "Upcoming releases and deadlines" })).toBeVisible();
  for (const [i, e] of cal.events.entries()) await expect(rows.nth(i)).toHaveAttribute("data-kind", e.kind);
  await expect(rows.filter({ hasText: "Source" })).toHaveCount(3);
  await expect(page.getByTestId("no-estimate")).toContainText("PayPal gives no timeline for this reason");

  // a day shows its events beside the grid
  await page.locator(`.b-calendar-cell[data-date="${review?.date ?? ""}"] .b-day-num`).click();
  await expect(page.getByTestId("day-panel").getByTestId("cash-row")).toHaveCount(2);

  await axeClean(page, "calendar-month-1440");
  await capture(page, "en-calendar-month", REVIEW_CAL, [768, 1440]);
  expect(calls, "requests that left localhost").toEqual([]);
  const trial = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("b-calendar")),
  );
  test.info().annotations.push({ type: "bryntum-localStorage", description: trial.join(", ") });
});

test("keyboard: Tab reaches every event; Enter opens the hold, Space opens the dispute", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { cal } = await seeded(page);
  await page.goto("/en/calendar?view=month");
  await expect(events(page)).toHaveCount(cal.events.length, { timeout: 60_000 });
  await page.getByTestId("view-switch").getByRole("button", { name: "Month" }).focus();
  const seen = new Set<string>();
  for (let i = 0; i < 120 && seen.size < cal.events.length; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-event-id") ?? null);
    if (id !== null) seen.add(id);
  }
  expect([...seen].sort()).toEqual(cal.events.map((e) => e.id).sort());

  const hold = cal.events.find((e) => e.kind === "estimated_release" && e.amount.currency === "USD");
  await page.locator(`.cash-bryntum [data-event-id="${hold?.id ?? ""}"]`).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/en/holds/${hold?.ref.id ?? ""}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Held: $64.00 USD");

  await page.goto("/en/calendar?view=month");
  const deadline = cal.events.find((e) => e.kind === "dispute_deadline");
  await expect(events(page)).toHaveCount(cal.events.length, { timeout: 60_000 });
  await page.locator(`.cash-bryntum [data-event-id="${deadline?.id ?? ""}"]`).focus();
  await page.keyboard.press(" ");
  await page.waitForURL(`**/en/disputes/${deadline?.ref.id ?? ""}`);
});

test("list view at 360: the default below 768 px, no horizontal scroll, every event, axe", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const calls = external(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const { cal } = await seeded(page);
  await page.goto("/en/calendar");
  await expect(page.getByTestId("calendar-area")).toHaveAttribute("data-view", "list");
  const rows = page.getByTestId("cash-list").getByTestId("cash-row");
  await expect(rows).toHaveCount(cal.events.length);
  for (const r of await rows.all()) expect((await r.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(56);
  await expect(page.getByTestId("cash-day").first()).toContainText("estimated");
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw).toBeLessThanOrEqual(cw);
  // the table is one disclosure away, with every event
  await page.getByText("Show as table").click();
  await expect(page.getByTestId("cash-table-row")).toHaveCount(cal.events.length);
  await axeClean(page, "calendar-list-360");
  // Enter on a row opens it
  await rows.first().getByTestId("cash-row-link").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/en\/(holds|disputes)\//);
  await page.goto("/en/calendar?view=list");
  await capture(page, "en-calendar-list", REVIEW_CAL);
  await page.goto("/hi/calendar?view=list");
  await capture(page, "hi-calendar-list", REVIEW_CAL, [360, 1440]);
  await page.goto("/hi/calendar?view=month");
  await expect(events(page)).toHaveCount(cal.events.length, { timeout: 60_000 });
  await capture(page, "hi-calendar-month", REVIEW_CAL, [1440]);
  expect(calls, "requests that left localhost").toEqual([]);
});

async function cellsIn(browser: Browser, cookie: Cookie, timezoneId: string) {
  const ctx = await browser.newContext({ timezoneId, viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([cookie]);
  const p = await ctx.newPage();
  await p.goto("/en/calendar?view=month");
  await expect(events(p)).toHaveCount(5, { timeout: 60_000 });
  const placed = await p.evaluate(() =>
    [...document.querySelectorAll(".cash-bryntum [data-event-id]")].map((e) => [
      e.getAttribute("data-event-id"),
      e.closest(".b-calendar-cell")?.getAttribute("data-date"),
    ]),
  );
  await ctx.close();
  return Object.fromEntries(placed) as Record<string, string>;
}

test("all-day days hold in browser zones behind and ahead of the workspace zone", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { ws } = await seeded(page);
  await sql("update workspaces set timezone = 'Asia/Kolkata' where id = $1", [ws]);
  const cal = CashCalendarResponseSchema.parse(await (await page.request.get("/api/cash-calendar")).json());
  expect(cal.timezone).toBe("Asia/Kolkata");
  const want = Object.fromEntries(cal.events.map((e) => [e.id, e.date]));
  const cookie = (await page.context().cookies()).find((c) => c.name.startsWith("__Host-cleared_session"));
  if (cookie === undefined) throw new Error("no session cookie");
  for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata"])
    expect(await cellsIn(browser, cookie, tz), tz).toEqual(want);
});

test("empty, loading and error states", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await demoWorkspace(page);
  await page.goto("/en/calendar");
  await expect(page.getByRole("heading", { name: "No held money." })).toBeVisible();
  await expect(page.getByTestId("held-now")).toHaveText("Nothing held now");
  await expect(page.getByTestId("cash-table")).toContainText("Nothing in this range.");
  await axeClean(page, "calendar-empty");
  await capture(page, "en-calendar-empty", REVIEW_CAL);

  await page.route("**/api/cash-calendar**", () => undefined);
  await page.goto("/en/calendar");
  await expect(page.getByTestId("loading")).toBeVisible();
  await expect(page.getByTestId("cash-table")).toBeVisible();
  await axeClean(page, "calendar-loading");
  await capture(page, "en-calendar-loading", REVIEW_CAL, [375, 1440]);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await page.route("**/api/cash-calendar**", (route) =>
    route.fulfill({
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000305",
      },
      body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
    }),
  );
  await page.goto("/en/calendar");
  await expect(page.getByText("Couldn't load the calendar")).toBeVisible();
  await expect(page.getByText("c0ffee00-5ce7-4d1e-9a7a-000000000305")).toBeVisible();
  await axeClean(page, "calendar-error");
  await capture(page, "en-calendar-error", REVIEW_CAL, [375, 1440]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
