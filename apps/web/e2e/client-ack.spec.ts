// M3-06 client acknowledgement link (local only: seeds the local database; the web and worker run with
// the msw PayPal and OpenAI stubs). The seller creates a link on the proof pack, the client opens it in a
// separate browser context with no session, sees the scope as plain text and confirms; the seller's panel
// then shows the acceptance. Review screenshots and axe results go to .review/M3-06/ (gitignored).
import { randomUUID } from "node:crypto";
import { closeDb, createDb, databaseUrl, type Db } from "@cleared/db";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { demoSeller, seedPayment } from "./support/pack-seed.ts";
import { capture, local, reviewDir } from "./support/review.ts";

const DIR = reviewDir("M3-06");
const SCOPE =
  "Three logo concepts and two rounds of revisions. Final files as SVG and PNG.\n<script>alert('xss')</script><img src=x onerror=alert(1)>";
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

/** The scope goes in through the real intake route (M2-01), so the pack state is what a seller sees. */
async function addScope(page: Page, packId: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const res = await page.request.post(`/api/packs/${packId}/evidence/text`, {
    headers: { origin, "idempotency-key": randomUUID() },
    data: { kind: "scope", text: SCOPE },
  });
  expect(res.status()).toBe(201);
}

async function packWithScope(page: Page, locale: "en" | "hi" = "en") {
  const ws = await demoSeller(page, locale);
  const { paymentId, packId } = await seedPayment(db, ws);
  await addScope(page, packId);
  await page.goto(`/${locale}/payments/${paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  return { ws, paymentId, packId };
}

async function createLink(page: Page): Promise<string> {
  await panel(page)
    .getByRole("button", { name: /acknowledgement link|पुष्टि लिंक बनाएँ/ })
    .click();
  const url = await page.getByTestId("ack-url").inputValue();
  expect(url).toMatch(/\/ack\/[A-Za-z0-9_-]{43}$/);
  return url;
}

/** A visitor with no session; records CSP violations so the test can assert there are none. */
async function client(browser: Browser) {
  const ctx = await browser.newContext({ locale: "en-US" });
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

test("seller creates a link; the client sees the scope as plain text and confirms; the seller sees it accepted", async ({
  page,
  browser,
}) => {
  const { packId } = await packWithScope(page);
  await expect(panel(page).getByRole("button", { name: "Create acknowledgement link" })).toBeVisible();
  const url = await createLink(page);
  await expect(panel(page)).toContainText("Waiting for your client");
  await capture(page, "seller-created", DIR);

  const c = await client(browser);
  const res = await c.page.goto(new URL(url).pathname);
  await expect(c.page).toHaveURL(/\/en\/ack\//);
  const headers = res?.headers() ?? {};
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-robots-tag"]).toContain("noindex");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  await expect(c.page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  // AC5: the scope's markup is text, never DOM
  const scope = c.page.getByTestId("ack-scope");
  await expect(scope).toHaveText(SCOPE);
  expect(await scope.locator("script, img").count()).toBe(0);
  // no script outside our own (nonce'd) bundle: every <script> carries the nonce or a same-origin src
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

  await c.page.getByLabel("Your name").fill("Asha <b>Rao</b>");
  await c.page.getByLabel("I agree to this scope").check();
  await c.page.getByRole("button", { name: "Confirm" }).click();
  await expect(c.page.getByTestId("ack-success")).toContainText("Thanks, Asha <b>Rao</b>.");
  await capture(c.page, "public-success", DIR);

  await c.page.reload();
  await expect(c.page.getByTestId("ack-neutral")).toContainText("This link can't be used");
  await expect(c.page.getByTestId("ack-scope")).toHaveCount(0);
  await capture(c.page, "public-neutral", DIR);
  expect(c.violations).toEqual([]);
  await c.ctx.close();

  // the seller's panel polls and shows the acceptance; the client_ack item is in the evidence list
  await expect(panel(page)).toContainText("Accepted", { timeout: 20_000 });
  await expect(page.getByTestId("ack-live")).toHaveText("Your client confirmed the scope.");
  await expect(page.getByTestId("evidence-list")).toContainText("client sign-off");
  const [row] = (
    await db.$client.query<{ n: string }>(
      "select count(*)::text n from evidence_items where pack_id = $1 and kind = 'client_ack'",
      [packId],
    )
  ).rows;
  expect(row?.n).toBe("1");
  await capture(page, "seller-accepted", DIR);
});

test("seller states: no scope, revoked, pending after reload; Hindi public page", async ({
  page,
  browser,
}) => {
  const ws = await demoSeller(page);
  const empty = await seedPayment(db, ws);
  await page.goto(`/en/payments/${empty.paymentId}/pack`);
  await expect(panel(page)).toContainText("Add the agreed scope first.");
  await capture(page, "seller-no-scope", DIR);

  const { packId, paymentId } = await seedPayment(db, ws, "85.00");
  await addScope(page, packId);
  await page.goto(`/en/payments/${paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  const url = await createLink(page);
  await page.reload();
  await expect(panel(page)).toContainText("for security the link is shown once");
  await capture(page, "seller-pending-reload", DIR);

  const c = await client(browser);
  await c.page.goto(new URL(url).pathname.replace("/ack/", "/hi/ack/"));
  await expect(c.page.getByRole("heading", { level: 1 })).toHaveText("तय काम की पुष्टि करें");
  await capture(c.page, "public-form-hi", DIR);

  await panel(page).getByRole("button", { name: "Revoke link" }).click();
  await expect(panel(page).getByRole("button", { name: "Keep link" })).toBeFocused();
  await panel(page).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(panel(page)).toContainText("Revoked");
  await expect(panel(page).getByRole("button", { name: "Create a new link" })).toBeVisible();
  await capture(page, "seller-revoked", DIR);

  await c.page.reload();
  await expect(c.page.getByTestId("ack-neutral")).toBeVisible();
  expect(c.violations).toEqual([]);
  await c.ctx.close();
});
