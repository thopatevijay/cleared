// M3-06 client acknowledgement link (local only: seeds the local database; the web and worker run with
// the msw PayPal and OpenAI stubs). The seller creates a link on the proof pack, the client opens it in a
// separate browser context with no session, sees the scope as plain text and confirms; the seller's panel
// then shows the acceptance. Every spec state is captured (client-ack.md); transient ones (loading,
// submitting, 429, 5xx, create failed) by holding or answering the one request with `page.route`.
// Review screenshots and axe results go to .review/M3-06/ (gitignored).
import { randomUUID } from "node:crypto";
import { closeDb, createDb, databaseUrl, type Db } from "@cleared/db";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";
import { demoSeller, seedPayment } from "./support/pack-seed.ts";
import { capture, local, reviewDir } from "./support/review.ts";

const DIR = reviewDir("M3-06");
const SCOPE =
  "Three logo concepts and two rounds of revisions. Final files as SVG and PNG.\n<script>alert('xss')</script><img src=x onerror=alert(1)>";
const SELLER = "Ravi Menon Design";
let db: Db;

test.beforeAll(() => {
  db = createDb(databaseUrl());
});
test.afterAll(async () => {
  await closeDb(db);
});
test.beforeEach(({ page }) => {
  test.skip(!local, "seeds the local database");
  page.on("dialog", (d) => {
    throw new Error(`dialog opened: ${d.message()}`);
  });
});

const panel = (page: Page) => page.getByTestId("ack-panel");
const sql = async (text: string, params: unknown[]) => db.$client.query(text, params);

/** The scope goes in through the real intake route (M2-01), so the pack state is what a seller sees. */
async function addScope(page: Page, packId: string, text = SCOPE): Promise<void> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(`/api/packs/${packId}/evidence/text`, {
    headers: { origin, "idempotency-key": randomUUID() },
    data: { kind: "scope", text },
  });
  expect(res.status()).toBe(201);
}

async function gotoPack(page: Page, locale: string, paymentId: string): Promise<void> {
  await page.goto(`/${locale}/payments/${paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
}

async function packWithScope(page: Page, locale: "en" | "hi" = "en") {
  const ws = await demoSeller(page, locale);
  const { paymentId, packId } = await seedPayment(db, ws);
  await addScope(page, packId);
  await gotoPack(page, locale, paymentId);
  return { ws, paymentId, packId };
}

async function createLink(page: Page): Promise<string> {
  await panel(page)
    .getByRole("button", { name: /acknowledgement link|a new link|पुष्टि लिंक बनाएँ/ })
    .click();
  const url = await page.getByTestId("ack-url").inputValue();
  expect(url).toMatch(/\/ack\/[A-Za-z0-9_-]{43}$/);
  return url;
}

/** A visitor with no session; records CSP violations so the test can assert there are none. */
async function client(browser: Browser) {
  const ctx = await browser.newContext({ locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content.Security.Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on("dialog", (d) => {
    throw new Error(`dialog opened: ${d.message()}`);
  });
  return { ctx, page, violations };
}

/** Holds one matching request until `release()`: the screen stays in its busy state for the capture. */
async function hold(page: Page, url: string, method: string) {
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    await gate;
    return route.fallback();
  });
  return () => {
    release();
  };
}

async function fillAndConfirm(page: Page, name: string): Promise<void> {
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("I agree to this scope").check();
  await page.getByRole("button", { name: "Confirm" }).click();
}

test("seller creates a link; the client sees the scope as plain text and confirms; the seller sees it accepted", async ({
  page,
  browser,
}) => {
  const { ws, packId, paymentId } = await packWithScope(page);
  await sql("insert into users (workspace_id, email, display_name) values ($1, $2, $3)", [
    ws,
    `ravi-${randomUUID()}@example.test`,
    SELLER,
  ]);
  await expect(panel(page).getByRole("button", { name: "Create acknowledgement link" })).toBeVisible();
  await capture(page, "seller-intro", DIR);

  const url = await createLink(page);
  await expect(panel(page)).toContainText("Waiting for your client");
  await capture(page, "seller-created", DIR);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel(page).getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByTestId("ack-copy-note")).toHaveText("Link copied");
  await capture(page, "seller-copied", DIR);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
  });
  await panel(page).getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByTestId("ack-copy-note")).toContainText("Couldn't copy.");
  await capture(page, "seller-copy-failed", DIR);

  const c = await client(browser);
  const res = await c.page.goto(new URL(url).pathname);
  await expect(c.page).toHaveURL(/\/en\/ack\//);
  const headers = res?.headers() ?? {};
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  await expect(c.page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(c.page.getByText(`${SELLER} asks you to confirm`)).toBeVisible();

  // AC5: the scope's markup is text, never DOM
  const scope = c.page.getByTestId("ack-scope");
  await expect(scope).toHaveText(SCOPE);
  expect(await scope.locator("script, img").count()).toBe(0);
  const foreign = await c.page.evaluate(
    () =>
      [...document.scripts].filter((s) => s.src !== "" && new URL(s.src).origin !== location.origin).length,
  );
  expect(foreign).toBe(0);
  await capture(c.page, "public-form", DIR);

  await c.page.getByRole("button", { name: "Confirm" }).click();
  await expect(c.page.getByText("Enter your name.")).toBeVisible();
  await expect(c.page.getByText("Tick the box to confirm you agree.")).toBeVisible();
  await expect(c.page.getByLabel("Your name")).toBeFocused();
  await capture(c.page, "public-errors", DIR);

  const release = await hold(c.page, "**/api/ack/*", "POST");
  await fillAndConfirm(c.page, "Asha <b>Rao</b>");
  await expect(c.page.getByRole("button", { name: "Confirming…" })).toBeVisible();
  await capture(c.page, "public-submitting", DIR);
  release();
  await expect(c.page.getByTestId("ack-success")).toContainText("Thanks, Asha <b>Rao</b>.");
  await expect(c.page.getByTestId("ack-success")).toContainText(/Recorded .*(IST|GMT\+5:30)/);
  await capture(c.page, "public-success", DIR);

  await c.page.reload();
  await expect(c.page.getByTestId("ack-neutral")).toContainText("This link can't be used");
  await expect(c.page.getByTestId("ack-scope")).toHaveCount(0);
  // sweep M5 (BL-01 6569408949 item 10): no "records this confirmation" footer where nothing can be confirmed;
  // the footer landmark stays, with the sandbox disclaimer
  await expect(c.page.getByTestId("ack-footer")).toHaveCount(0);
  await expect(c.page.getByRole("contentinfo")).toHaveText("Sandbox only. Cleared is not affiliated with PayPal.");
  await capture(c.page, "public-neutral", DIR);
  expect(c.violations).toEqual([]);
  await c.ctx.close();

  // the seller's panel polls and shows the acceptance; the client_ack item is a plain-language record
  await expect(panel(page)).toContainText("Accepted", { timeout: 20_000 });
  await expect(page.getByTestId("ack-live")).toHaveText("Your client confirmed the scope.");
  const item = page.locator("[data-testid=evidence-item][data-kind=client_ack]");
  await expect(item).toContainText("Confirmed by Asha <b>Rao</b>");
  await expect(item).toContainText("Recorded by Cleared from the client's link");
  await expect(item).not.toContainText("accepted_at");
  const { rows } = await sql(
    "select count(*)::text n from evidence_items where pack_id = $1 and kind = 'client_ack'",
    [packId],
  );
  expect((rows[0] as { n: string }).n).toBe("1");
  await capture(page, "seller-accepted", DIR);

  // a newer scope: the accepted row stays, labelled as for the earlier scope
  await addScope(page, packId, `${SCOPE}\nPlus a favicon.`);
  await gotoPack(page, "en", paymentId);
  await expect(panel(page)).toContainText("for an earlier version of the scope");
  await capture(page, "seller-accepted-earlier-scope", DIR);
});

test("seller states: loading, no scope, pending after reload, revoke, expired, capped, scope changed, failures, offline", async ({
  page,
  browser,
}) => {
  const ws = await demoSeller(page);
  const empty = await seedPayment(db, ws);
  await gotoPack(page, "en", empty.paymentId);
  await expect(panel(page)).toContainText("Add the agreed scope first.");
  await capture(page, "seller-no-scope", DIR);

  const { packId, paymentId } = await seedPayment(db, ws, "85.00");
  await addScope(page, packId);
  const holdView = await hold(page, `**/api/packs/${packId}/ack-links`, "GET");
  await page.goto(`/en/payments/${paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  await capture(page, "seller-loading", DIR);
  holdView();
  await page.unrouteAll({ behavior: "wait" });

  // the workspace ends in 3 days: the link's expiry is capped to it
  await sql("update workspaces set expires_at = now() + interval '3 days' where id = $1", [ws]);
  const url = await createLink(page);
  await expect(panel(page)).toContainText("when this demo workspace ends");
  await page.reload();
  await expect(panel(page)).toContainText("for security the link is shown once");
  await capture(page, "seller-pending-reload", DIR);

  // the public page's transient states, on this live link
  const c = await client(browser);
  await c.page.route("**/api/ack/*", (r) =>
    r.fulfill({ status: 429, headers: { "retry-after": "900" }, json: { error: { code: "rate_limited" } } }),
  );
  await c.page.goto(new URL(url).pathname);
  await fillAndConfirm(c.page, "Asha Rao");
  await expect(c.page.getByText("Too many attempts. Try again in a few minutes.")).toBeVisible();
  await capture(c.page, "public-rate-limited", DIR);
  await c.page.unrouteAll({ behavior: "wait" });
  await c.page.route("**/api/ack/*", (r) =>
    r.fulfill({ status: 500, headers: { "x-correlation-id": randomUUID() }, json: { error: {} } }),
  );
  await c.page.getByRole("button", { name: "Confirm" }).click();
  await expect(c.page.getByTestId("error-panel")).toContainText("Couldn't record your confirmation.");
  await capture(c.page, "public-error", DIR);
  await c.page.unrouteAll({ behavior: "wait" });
  await c.page.goto(new URL(url).pathname.replace("/ack/", "/hi/ack/"));
  await expect(c.page.getByRole("heading", { level: 1 })).toHaveText("तय काम की पुष्टि करें");
  // BL-01 6569232529: a demo workspace names the scenario's synthetic seller, not the fallback
  await expect(c.page.getByText("Meera Studio आपसे")).toBeVisible();
  await capture(c.page, "public-form-hi", DIR);

  await panel(page).getByRole("button", { name: "Revoke link" }).click();
  await expect(panel(page).getByRole("button", { name: "Keep link" })).toBeFocused();
  await capture(page, "seller-revoke-confirm", DIR);
  const revokeUrl = `**/api/packs/${packId}/ack-links/*/revoke`;
  await page.route(revokeUrl, (r) =>
    r.fulfill({ status: 500, headers: { "x-correlation-id": randomUUID() }, json: { error: {} } }),
  );
  await panel(page).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(panel(page).getByTestId("error-panel")).toContainText("Couldn't revoke the link.");
  await capture(page, "seller-revoke-failed", DIR);
  await page.unrouteAll({ behavior: "wait" });
  const releaseRevoke = await hold(page, revokeUrl, "POST");
  await panel(page).getByRole("button", { name: "Revoke", exact: true }).click();
  const revoking = panel(page).getByRole("button", { name: "Revoking…" });
  await expect(revoking).toBeVisible();
  // sweep M5 (BL-01 6569408949 item 9): a spinner and the full-strength fill, not the faded disabled one
  await expect(revoking.locator("svg.animate-spin")).toHaveCount(1);
  await expect(revoking).toHaveAttribute("aria-busy", "true");
  await expect(revoking).toHaveCSS("opacity", "1");
  await capture(page, "seller-revoking", DIR);
  releaseRevoke();
  await expect(panel(page)).toContainText("Revoked");
  await expect(panel(page).getByRole("button", { name: "Create a new link" })).toBeVisible();
  await capture(page, "seller-revoked", DIR);
  await c.page.goto(new URL(url).pathname);
  await expect(c.page.getByTestId("ack-neutral")).toBeVisible();
  expect(c.violations).toEqual([]);
  await c.ctx.close();

  await page.route(`**/api/packs/${packId}/ack-links`, (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 500, headers: { "x-correlation-id": randomUUID() }, json: { error: {} } })
      : r.fallback(),
  );
  await panel(page).getByRole("button", { name: "Create a new link" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("Couldn't create the link.");
  await capture(page, "seller-create-failed", DIR);
  await page.unrouteAll({ behavior: "wait" });

  await page.context().setOffline(true);
  await expect(panel(page)).toContainText("You're offline.");
  await capture(page, "seller-offline", DIR);
  await page.context().setOffline(false);

  // expired, then scope changed
  await page.reload();
  await createLink(page);
  await sql(
    "update client_acks set expires_at = now() - interval '1 minute' where pack_id = $1 and revoked_at is null",
    [packId],
  );
  await page.reload();
  await expect(panel(page)).toContainText("expired on");
  await capture(page, "seller-expired", DIR);
  await createLink(page);
  await addScope(page, packId, `${SCOPE}\nPlus a favicon.`);
  await page.reload();
  await expect(panel(page)).toContainText("The scope changed after you created this link");
  await capture(page, "seller-scope-changed", DIR);
});

test("Hindi seller panel", async ({ page }) => {
  await packWithScope(page, "hi");
  await createLink(page);
  await expect(panel(page)).toContainText("क्लाइंट के जवाब का इंतज़ार");
  await capture(page, "seller-created-hi", DIR);
});
