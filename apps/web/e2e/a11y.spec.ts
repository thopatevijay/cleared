// M4-04 AC 1 (local, fixture replay): axe (WCAG 2.0/2.1/2.2 A and AA rules) finds 0 serious or critical
// violations on every route × {en, hi} × {populated, empty, loading, error}. Loading holds the screen's
// data request open; error answers it with a 500 and a correlation id; empty is a fresh demo seller (or an
// empty proof pack). A state a screen does not have is listed in NOT_APPLICABLE with its reason, never
// invented. Populated screens run axe at 375 px (light) and 1280 px (dark); the other states at 1280 px.
// Each test writes its rows of the result matrix to .review/M4-04/a11y/ for docs/evidence/a11y-report.md.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { WorkspaceIdSchema } from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import hi from "../messages/hi.json" with { type: "json" };
import { inFlight, seed as seedDispute } from "./support/disputes.ts";
import {
  failRequests,
  holdRequests,
  SCREENS,
  screenReady,
  seedJourney,
  type Locale,
  type State,
} from "./support/journey.ts";
import { demoSeller, LOGO_LINES, seedChecked, seedPayment } from "./support/pack-seed.ts";
import { axe, local, reviewDir } from "./support/review.ts";

const DIR = reviewDir("M4-04");
const LOCALES: readonly Locale[] = ["en", "hi"];

test.skip(!local, "local only: fixture replay");

/** Route × state pairs that do not exist, with the reason (docs/evidence/a11y-report.md lists them). */
const NOT_APPLICABLE: Readonly<Record<string, Partial<Record<State, string>>>> = {
  "hold-detail": { empty: "a hold detail always has its hold; an unknown id is the error state" },
  "dispute-review": { empty: "a dispute review always has its dispute; an unknown id is the error state" },
  scenario: { empty: "a scenario page always has its run; an unknown id is the error state" },
  settings: { empty: "the time-zone control always shows the workspace's zone" },
  landing: { empty: "a static page: nothing to be empty" },
  "signin-expired": {
    empty: "a static page",
    loading: "a static page: no request after it loads",
    error: "it is itself the error page of a sign-in link",
  },
  ack: { empty: "a link always carries its scope; an unusable link is the error state" },
};

interface Row {
  readonly route: string;
  readonly locale: Locale;
  readonly state: State;
  readonly serious: number;
  readonly moderate: number;
  readonly minor: number;
}

/** Collects one test's matrix rows; `save` writes them (one file per test, so a retry overwrites). */
function matrix(file: string) {
  const rows: Row[] = [];
  return {
    async check(page: Page, route: string, locale: Locale, state: State): Promise<void> {
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const name = `${locale}-${route}-${state}`;
      const runs: { serious: number; moderate: number; minor: number }[] = [];
      if (state === "populated") {
        await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
        await page.setViewportSize({ width: 375, height: 800 });
        runs.push(await axe(page, `${name}-375-light`, DIR, true));
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1280, height: 900 });
        runs.push(await axe(page, `${name}-1280-dark`, DIR, true));
        await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
      } else {
        runs.push(await axe(page, `${name}-1280-light`, DIR, true));
      }
      const max = (k: "serious" | "moderate" | "minor") => Math.max(...runs.map((r) => r[k]));
      rows.push({
        route,
        locale,
        state,
        serious: max("serious"),
        moderate: max("moderate"),
        minor: max("minor"),
      });
    },
    save(): void {
      mkdirSync(`${DIR}a11y`, { recursive: true });
      writeFileSync(`${DIR}a11y/${file}.json`, JSON.stringify(rows, null, 2));
      const na = Object.entries(NOT_APPLICABLE).flatMap(([route, s]) =>
        Object.entries(s).map(([state, reason]) => ({ route, state, reason })),
      );
      writeFileSync(`${DIR}a11y/not-applicable.json`, JSON.stringify(na, null, 2));
    },
  };
}

// WCAG 4.1.3: the three status messages the ticket names are spoken without moving focus. Each region is
// on the page before its message changes (a region added together with its text is not announced).
test("status messages: pack check, filing status and the wait for PayPal are live regions", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const ws = await demoSeller(page, "en");
  const db = createDb(databaseUrl());
  let paymentId: string;
  let scenarioId: string;
  try {
    ({ paymentId } = await seedChecked(db, ws, LOGO_LINES));
    ({ id: scenarioId } = await forWorkspace(db, WorkspaceIdSchema.parse(ws)).scenarioRuns.insert({
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
    }));
  } finally {
    await closeDb(db);
  }
  // the pack's check result
  await page.goto(`/en/payments/${paymentId}/pack`);
  const banner = page.getByTestId("pack-banner");
  await expect(banner).toHaveAttribute("aria-live", "polite");
  await expect(banner).toContainText("met");

  // the filing status: proposed → Sending, announced by the page's poll
  const dispute = await seedDispute(ws);
  await page.goto(`/en/disputes/${dispute.disputeRowId}`);
  const filing = page.getByTestId("filing-status");
  await filing.waitFor();
  const live = filing.locator("[aria-live=polite]");
  await expect(live).toHaveText("");
  await inFlight(ws, dispute, "executing");
  await expect(live).toHaveText("Sending", { timeout: 30_000 });

  // the scenario's step in progress and its wait
  await page.goto(`/en/scenario/${scenarioId}`);
  await expect(page.getByTestId("scenario-live")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("scenario-live")).not.toHaveText("");
});

// prefers-reduced-motion: with `reduce`, no skeleton pulse, spinner or flash keeps running on any screen,
// loading or loaded (Web Animations API: every running CSS animation on the page).
test("prefers-reduced-motion: no running animation on any screen, loading or loaded", async ({ page }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const j = await seedJourney(page, "en");
  const running = () =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return `${a instanceof CSSAnimation ? a.animationName : "animation"} on ${t?.getAttribute("class") ?? t?.tagName ?? "?"}`;
        }),
    );
  for (const s of SCREENS) {
    await page.goto(`/en${s.path(j)}`);
    await screenReady(page, s.ready);
    expect.soft(await running(), `running animations on ${s.name}`).toEqual([]);
    if (s.api === undefined) continue;
    const release = await holdRequests(page, s.api);
    await page.goto(`/en${s.path(j)}`);
    await page
      .getByTestId(s.loading ?? "loading")
      .first()
      .waitFor();
    expect.soft(await running(), `running animations on ${s.name} (loading)`).toEqual([]);
    await release();
  }
});

// WCAG 3.3.8 accessible authentication: sign-in is a magic link to an email address the browser can fill
// (autocomplete="email", paste allowed); no puzzle, no password, no third-party challenge frame.
test("3.3.8: sign-in asks for an email the browser can fill, and nothing else", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/en");
  const email = page.locator("form input[type=email]");
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(page.locator("form input[type=password]")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  const pastePrevented = await email.evaluate((el) => {
    const ev = new ClipboardEvent("paste", { cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(pastePrevented, "paste into the email field is allowed").toBe(false);
});

for (const locale of LOCALES) {
  test(`populated, loading and error: every signed-in route (${locale})`, async ({ page }) => {
    test.setTimeout(600_000);
    const m = matrix(`${locale}-signed-in`);
    await page.setViewportSize({ width: 1280, height: 900 });
    const j = await seedJourney(page, locale);
    for (const s of SCREENS) {
      const path = `/${locale}${s.path(j)}`;
      await test.step(`${s.name} populated`, async () => {
        await page.goto(path);
        await screenReady(page, s.ready);
        await m.check(page, s.name, locale, "populated");
      });
      if (s.api === undefined) continue;
      const api = s.api;
      await test.step(`${s.name} loading`, async () => {
        const release = await holdRequests(page, api);
        await page.goto(path);
        await page
          .getByTestId(s.loading ?? "loading")
          .first()
          .waitFor();
        await m.check(page, s.name, locale, "loading");
        await release();
      });
      await test.step(`${s.name} error`, async () => {
        const restore = await failRequests(page, api);
        await page.goto(path);
        await page.getByTestId("error-panel").first().waitFor();
        await m.check(page, s.name, locale, "error");
        await restore();
      });
    }
    m.save();
  });

  test(`settings: the time-zone control open, saving and failed (${locale})`, async ({ page }) => {
    test.setTimeout(180_000);
    const m = matrix(`${locale}-settings`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await demoSeller(page, locale);
    const tz = page.getByTestId("tz-control");
    await tz.getByTestId("tz-change").click();
    await expect(tz.getByTestId("tz-select")).toBeFocused();
    await m.check(page, "settings", locale, "populated");
    const release = await holdRequests(page, "**/api/workspace", "PATCH");
    await tz.getByTestId("tz-select").selectOption("Africa/Lagos");
    await tz.getByTestId("tz-save").click();
    await expect(tz.getByTestId("tz-save")).toHaveAttribute("aria-busy", "true");
    await m.check(page, "settings", locale, "loading");
    // a saved zone ends with router.refresh() (TimeZoneControl); Next 16 re-streams the page metadata, and
    // <title> is out of the DOM until that chunk lands (~0.4 s on the CI runner). The save is over once the
    // refresh has landed and the page has its title again; only then does the next state start.
    const title = `${(locale === "en" ? en : hi).dashboard.title} · Cleared`;
    const refreshed = page.waitForResponse(
      (r) => r.request().headers()["rsc"] === "1" && new URL(r.url()).pathname === `/${locale}/payments`,
    );
    await release();
    await expect(tz.getByTestId("tz-current")).toHaveText("Africa/Lagos");
    await (await refreshed).finished();
    await expect(page).toHaveTitle(title);
    await tz.getByTestId("tz-change").click();
    const restore = await failRequests(page, "**/api/workspace", "PATCH");
    await tz.getByTestId("tz-select").selectOption("Asia/Kolkata");
    await tz.getByTestId("tz-save").click();
    await expect(tz.getByTestId("tz-error")).toBeVisible();
    await expect(page).toHaveTitle(title);
    await m.check(page, "settings", locale, "error");
    await restore();
    m.save();
  });

  test(`empty: a new demo seller and an empty proof pack (${locale})`, async ({ page }) => {
    test.setTimeout(300_000);
    const m = matrix(`${locale}-empty`);
    await page.setViewportSize({ width: 1280, height: 900 });
    const ws = await demoSeller(page, locale);
    for (const [route, path, ready] of [
      ["payments", "/payments", "empty-state"],
      ["holds", "/holds", "empty-state"],
      ["disputes", "/disputes", "empty-state"],
      ["calendar", "/calendar", "empty-state"],
      ["audit", "/audit", "audit-list"],
      ["notifications", "/notifications", "empty-state"],
    ] as const) {
      await test.step(route, async () => {
        await page.goto(`/${locale}${path}`);
        await screenReady(page, ready);
        await m.check(page, route, locale, "empty");
      });
    }
    const db = createDb(databaseUrl());
    let paymentId: string;
    try {
      ({ paymentId } = await seedPayment(db, ws, "45.00"));
    } finally {
      await closeDb(db);
    }
    await page.goto(`/${locale}/payments/${paymentId}/pack`);
    await page.locator("[data-testid=intake][data-ready=true]").waitFor();
    await m.check(page, "pack", locale, "empty");
    m.save();
  });

  test(`public pages: landing, sign-in link expired, client acknowledgement (${locale})`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    const m = matrix(`${locale}-public`);
    // a seller's pack with an acknowledgement link (the client opens it below)
    const ws = await demoSeller(page, locale);
    const db = createDb(databaseUrl());
    let packId: string;
    try {
      ({ packId } = await seedChecked(db, ws, LOGO_LINES));
    } finally {
      await closeDb(db);
    }
    const res = await page.request.post(`/api/packs/${packId}/ack-links`, {
      headers: { origin: new URL(page.url()).origin, "idempotency-key": randomUUID() },
      data: {},
    });
    expect(res.status()).toBe(201);
    const ackPath = new URL(((await res.json()) as { url: string }).url).pathname;

    await page.context().clearCookies();
    await page.goto(`/${locale}`);
    await page.getByTestId("demo-cta").waitFor();
    await m.check(page, "landing", locale, "populated");
    const release = await holdRequests(page, "**/api/demo", "POST");
    await page.getByTestId("demo-cta").click();
    await expect(page.getByTestId("demo-cta")).toHaveAttribute("aria-busy", "true");
    await m.check(page, "landing", locale, "loading");
    await page.unroute("**/api/demo");
    await page.goto(`/${locale}`);
    await release();
    await page.context().clearCookies();
    await page.goto(`/${locale}`);
    const restore = await failRequests(page, "**/api/demo", "POST");
    await page.getByTestId("demo-cta").click();
    // in <main>: Next's own route announcer (body > next-route-announcer, empty until a client navigation)
    // is a second role=alert on every page
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await m.check(page, "landing", locale, "error");
    await restore();

    await page.goto(`/${locale}/signin/expired`);
    await page.locator("main h1").waitFor();
    await m.check(page, "signin-expired", locale, "populated");

    // the client's view: no session
    const ctx = await browser.newContext();
    const client = await ctx.newPage();
    await client.setViewportSize({ width: 1280, height: 900 });
    await client.goto(`/${locale}${ackPath}`);
    const confirm = client.locator("form button[type=submit]");
    await confirm.waitFor();
    await m.check(client, "ack", locale, "populated");
    const hold = await holdRequests(client, "**/api/ack/**", "POST");
    await client.locator("form input:not([type=checkbox])").first().fill("Asha Rao");
    await client.locator("form input[type=checkbox]").first().check();
    await confirm.click();
    await expect(client.locator("form[aria-busy=true]")).toBeVisible();
    await m.check(client, "ack", locale, "loading");
    await hold();
    await client.goto(`/${locale}/ack/${randomUUID().replaceAll("-", "")}unusable00000000000`);
    await client.getByTestId("ack-neutral").waitFor();
    await m.check(client, "ack", locale, "error");
    await ctx.close();
    m.save();
  });
}
