// Sweep M4 (BL-01 6629801956): the dashboard footer's "Sign out" ends the session. It is a real button
// (keyboard: Enter), the request clears the cookie, the browser lands on the landing page, and the workspace
// API then refuses. HI shows the HI label.
import { expect, test } from "@playwright/test";
import { demoWorkspace, local } from "./support/disputes.ts";

test.skip(!local, "local only: it starts demo workspaces");

test("Sign out in the dashboard footer ends the session", async ({ page }) => {
  await demoWorkspace(page);
  expect((await page.request.get("/api/workspace")).status()).toBe(200);
  const button = page.getByRole("contentinfo").getByRole("button", { name: "Sign out" });
  await button.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/en$/);
  await expect(page.getByTestId("demo-cta")).toBeVisible();
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
});

test("the HI footer shows the HI label", async ({ page }) => {
  await demoWorkspace(page, "hi");
  await expect(page.getByRole("contentinfo").getByRole("button", { name: "साइन आउट करें" })).toBeVisible();
});
