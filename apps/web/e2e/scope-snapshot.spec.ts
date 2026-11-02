// M3-07 scope snapshot over HTTP (local only: seeds the local database; web and worker run with the msw
// PayPal and OpenAI stubs). The seller adds the scope through the intake route, clicks "Create scope
// snapshot" on the proof pack, the worker renders it, and the download is a PDF attachment that another
// workspace cannot fetch.
import { randomUUID } from "node:crypto";
import { closeDb, createDb, databaseUrl, type Db } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import { demoSeller, seedPayment } from "./support/pack-seed.ts";
import { local } from "./support/review.ts";

const SCOPE = "Logo in SVG and PNG, three colour variants, two revision rounds. Final files by 20 October.";
let db: Db;

test.beforeAll(() => {
  db = createDb(databaseUrl());
});
test.afterAll(async () => {
  await closeDb(db);
});
test.beforeEach(() => {
  test.skip(!local, "seeds the local database");
});

async function packWithScope(page: Page) {
  const ws = await demoSeller(page, "en");
  const { paymentId, packId } = await seedPayment(db, ws);
  const res = await page.request.post(`/api/packs/${packId}/evidence/text`, {
    headers: { origin: new URL(page.url()).origin, "idempotency-key": randomUUID() },
    data: { kind: "scope", text: SCOPE },
  });
  expect(res.status()).toBe(201);
  await page.goto(`/en/payments/${paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
  return { ws, packId };
}

test("the seller creates a scope snapshot and downloads it; another workspace gets a 404", async ({
  page,
  browser,
}) => {
  const { packId } = await packWithScope(page);
  const panel = page.getByTestId("snapshot-panel");
  await expect(panel.getByTestId("snapshot-download")).toHaveCount(0);
  await panel.getByRole("button", { name: "Create scope snapshot" }).click();
  await expect(panel.getByText("Creating the snapshot")).toBeVisible();
  await expect(panel.getByTestId("snapshot-download")).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('[data-kind="scope_snapshot"]')).toHaveCount(1);

  const res = await page.request.get(`/api/packs/${packId}/scope-snapshot`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect(res.headers()["content-disposition"]).toMatch(
    /^attachment; filename="scope-snapshot-[0-9a-f]{12}\.pdf"$/,
  );
  const body = await res.body();
  expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(body.byteLength).toBeLessThan(10_000_000);

  const download = page.waitForEvent("download");
  await panel.getByTestId("snapshot-download").click();
  expect((await download).suggestedFilename()).toMatch(/^scope-snapshot-[0-9a-f]{12}\.pdf$/);

  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const otherPage = await other.newPage();
  await demoSeller(otherPage, "en");
  expect((await otherPage.request.get(`/api/packs/${packId}/scope-snapshot`)).status()).toBe(404);
  await other.close();
});
