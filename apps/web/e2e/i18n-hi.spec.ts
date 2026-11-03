// M4-03 AC 5 (local, fixture replay: the msw PayPal stub and the recorded OpenAI responses): the judge path
// in Hindi, from "Try as demo seller" on /hi through the payment, its proof pack, the held money and its
// detail, the dispute and its reply review, the scenario page, the cash calendar, the audit log and the
// notifications. On every screen: `<html lang="hi">`, no missing-message warning in the console and no
// raw message key on the page, and no horizontal scroll at 320 px. Then the settings the ticket adds: the
// footer's time-zone control re-renders deadlines in the new zone, and the language switch persists the
// workspace locale. Screenshots for the ui-reviewer go to .review/M4-03/ (gitignored): 320 px for every
// screen, and the full width/theme set (with axe) for the screens this ticket changed, in HI and EN.
import { WorkspaceIdSchema } from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace } from "@cleared/db";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import { seed as seedDispute } from "./support/disputes.ts";
import { seedHeld } from "./support/holds.ts";
import { demoSeller, LOGO_LINES, seedChecked } from "./support/pack-seed.ts";
import { capture, local, reviewDir, shots } from "./support/review.ts";

const DIR = reviewDir("M4-03");

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: fixture replay");

/** Every message key path with two or more dots ("disputes.draft.notesLabel"): rendered raw only when missing. */
function keyPaths(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const key = prefix === "" ? k : `${prefix}.${k}`;
    return typeof v === "object" && v !== null
      ? keyPaths(v as object, key)
      : key.split(".").length > 2
        ? [key]
        : [];
  });
}
const KEYS = keyPaths(en);

function watchConsole(page: Page): string[] {
  const missing: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (/MISSING_MESSAGE|IntlError|missing message/i.test(m.text())) missing.push(m.text());
  });
  return missing;
}

/** lang="hi", no raw key, no side scroll and a screenshot at 320 px. */
async function checkHi(page: Page, name: string): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const text = await page.locator("body").innerText();
  expect(
    KEYS.filter((k) => text.includes(k)),
    `raw message keys on ${name}`,
  ).toEqual([]);
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `horizontal scroll at 320 px on ${name}`).toBeLessThanOrEqual(cw);
  if (shots) await page.screenshot({ path: `${DIR}hi-${name}-320-light.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function ready(page: Page, path: string, testId: string): Promise<void> {
  await page.goto(path);
  await page.getByTestId(testId).first().waitFor();
  await expect(page.getByTestId("loading")).toHaveCount(0);
  await expect(page.getByTestId("tz-current")).toBeVisible();
}

test("the judge path in Hindi: lang, messages, 320 px", async ({ page }) => {
  test.setTimeout(900_000);
  const missing = watchConsole(page);

  await page.context().clearCookies();
  await page.goto("/hi");
  await page.getByTestId("demo-cta").waitFor();
  await checkHi(page, "landing");
  if (shots) await capture(page, "hi-landing", DIR);

  const ws = await demoSeller(page, "hi");
  const workspace = (await (await page.request.get("/api/workspace")).json()) as {
    workspace: { locale: string };
  };
  expect(workspace.workspace.locale, "a demo started on /hi is a Hindi workspace").toBe("hi");

  const db = createDb(databaseUrl());
  let pack: { paymentId: string };
  let scenarioId: string;
  try {
    pack = await seedChecked(db, ws, LOGO_LINES);
    const run = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).scenarioRuns.insert({
      state: "capturing",
      orderId: null,
      captureId: null,
      disputeId: null,
      pollStartedAt: null,
      lastPolledAt: null,
      decisionRequestedAt: null,
      finishedAt: null,
      failure: null,
      steps: {},
    });
    scenarioId = run.id;
  } finally {
    await closeDb(db);
  }
  const hold = await seedHeld(ws);
  const dispute = await seedDispute(ws);

  const screens: [name: string, path: string, testId: string, full: boolean][] = [
    ["payments", "/hi/payments", "payment-row", true],
    ["pack", `/hi/payments/${pack.paymentId}/pack`, "verdict-row", false],
    ["holds", "/hi/holds", "hold-row", true],
    ["hold-detail", `/hi/holds/${hold.holdId}`, "hold-detail", false],
    ["disputes", "/hi/disputes", "dispute-row", true],
    ["dispute-review", `/hi/disputes/${dispute.disputeRowId}`, "approval-card", true],
    ["scenario", `/hi/scenario/${scenarioId}`, "scenario-timeline", false],
    ["calendar", "/hi/calendar", "calendar-area", false],
    ["audit", "/hi/audit", "audit-list", false],
    ["notifications", "/hi/notifications", "notification", false],
  ];
  for (const [name, path, testId, full] of screens) {
    await test.step(name, async () => {
      await ready(page, path, testId);
      await checkHi(page, name);
      if (shots && full) await capture(page, `hi-${name}`, DIR);
    });
  }

  // the reply is filed in English, and the screen says so
  await page.goto(`/hi/disputes/${dispute.disputeRowId}`);
  await expect(page.getByTestId("notes-english")).toHaveText(
    "PayPal को यह जवाब अंग्रेज़ी में भेजा जाता है, चाहे आप यहाँ कोई भी भाषा चुनें।",
  );
  await expect(page.getByTestId("notes")).toHaveAttribute("lang", "en");
  // 24-hour clock in Hindi: no Latin am/pm in the page
  expect(await page.locator("main").innerText()).not.toMatch(/\d (am|pm)\b/);

  expect(missing, "missing-message warnings in the console").toEqual([]);
});

test("time-zone control: deadlines re-render in the new zone; UTC in the tooltip", async ({ page }) => {
  test.setTimeout(300_000);
  const missing = watchConsole(page);
  for (const locale of ["hi", "en"] as const) {
    const ws = await demoSeller(page, locale);
    const s = await seedDispute(ws);
    await ready(page, `/${locale}/disputes/${s.disputeRowId}`, "approval-card");
    const tz = page.getByTestId("tz-control");
    const before = await tz.getByTestId("tz-current").innerText();

    await tz.getByTestId("tz-change").click();
    await expect(tz.getByTestId("tz-select")).toBeFocused();
    await expect(tz.getByTestId("tz-select")).toHaveValue(before);
    if (shots) {
      await tz.scrollIntoViewIfNeeded();
      await capture(page, `${locale}-tz-open`, DIR);
    }
    // Escape closes and returns focus
    await page.keyboard.press("Escape");
    await expect(tz.getByTestId("tz-change")).toBeFocused();
    await expect(tz.getByTestId("tz-change")).toHaveAttribute("aria-expanded", "false");

    // a failed save keeps the old zone and says so
    await tz.getByTestId("tz-change").click();
    await page.route("**/api/workspace", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
        : route.fallback(),
    );
    await tz.getByTestId("tz-select").selectOption("Africa/Lagos");
    await tz.getByTestId("tz-save").click();
    await expect(tz.getByTestId("tz-error")).toBeVisible();
    await expect(tz.getByTestId("tz-current")).toHaveText(before);
    if (shots) await capture(page, `${locale}-tz-error`, DIR);
    await page.unroute("**/api/workspace");

    await tz.getByTestId("tz-save").click();
    await expect(tz.getByTestId("tz-current")).toHaveText("Africa/Lagos");
    await expect(tz.getByTestId("tz-saved")).toContainText("Africa/Lagos");
    await expect(tz.getByTestId("tz-change")).toBeFocused();
    // the dispute's deadline now reads in Lagos time, with UTC in the tooltip
    const due = page.getByTestId("approval-card").locator("p[title]").first();
    await expect(due).toContainText("GMT+1");
    await expect(due).toHaveAttribute("title", /UTC$/);
    if (shots) await capture(page, `${locale}-tz-saved`, DIR);
    const after = (await (await page.request.get("/api/workspace")).json()) as {
      workspace: { timezone: string };
    };
    expect(after.workspace.timezone).toBe("Africa/Lagos");
  }
  expect(missing).toEqual([]);
});

test("the language switch persists the workspace locale", async ({ page }) => {
  test.setTimeout(120_000);
  await demoSeller(page, "en");
  const locale = async () =>
    ((await (await page.request.get("/api/workspace")).json()) as { workspace: { locale: string } }).workspace
      .locale;
  expect(await locale()).toBe("en");
  await page.getByRole("link", { name: "हिन्दी" }).click();
  await page.waitForURL("**/hi/payments");
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  await expect.poll(locale, { message: "workspaces.locale follows the switch" }).toBe("hi");
  await page.getByRole("link", { name: "English" }).click();
  await page.waitForURL("**/en/payments");
  await expect.poll(locale).toBe("en");
});
