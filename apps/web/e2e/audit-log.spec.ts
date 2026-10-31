// M2-09 E2E (local): after the approve flow, /en/audit lists proposed → approved → checks → sent → mirrored
// outcome, newest first, grouped by day, each row with an actor icon + word and PayPal's debug_id on the
// sent row; no row offers edit or delete. Filters narrow it; "Clear filters" restores it. /hi/audit renders
// the HI strings (the M1-07 placeholder is gone) and the empty state's sentence. axe and 360 px on each.
import { expect, test } from "@playwright/test";
import { approveByKeyboard, capture, demoWorkspace, local, seed } from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: the msw stub stands in for PayPal");

test("the audit log after an approved, filed and resolved dispute reply", async ({ page }) => {
  test.setTimeout(360_000);
  const ws = await demoWorkspace(page);
  const s = await seed(ws);
  await page.goto(`/en/disputes/${s.disputeRowId}`);
  await approveByKeyboard(page);

  await page.goto("/en/audit");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Audit log");
  await expect(page.getByText("Every action on your workspace, oldest entries kept.")).toBeVisible();
  const rows = page.getByTestId("audit-row");
  await expect(page.locator('[data-testid="audit-row"][data-action="dispute.status_changed"]')).toHaveCount(
    1,
    {
      timeout: 30_000,
    },
  );
  const actions = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-action") ?? ""));
  const at = (a: string): number => actions.indexOf(a);
  const lastAt = (a: string): number => actions.lastIndexOf(a);
  // newest first: mirrored outcome → sent → checks → approved → proposed
  expect(at("dispute.status_changed")).toBeLessThan(at("action.sent"));
  expect(at("action.sent")).toBeLessThan(at("action.check"));
  expect(lastAt("action.check")).toBeLessThan(at("action.approved"));
  expect(at("action.approved")).toBeLessThan(at("action.proposed"));
  expect(actions.filter((a) => a === "action.check").length).toBe(6);
  // grouped by day (h2), each row with actor icon + word
  await expect(page.getByTestId("audit-day").first().getByRole("heading", { level: 2 })).toBeVisible();
  for (const r of await rows.all()) {
    const actor = r.getByTestId("audit-actor");
    await expect(actor.locator("svg")).toHaveCount(1);
    await expect(actor).toHaveText(/\S/);
  }
  const outcome = page.locator('[data-testid="audit-row"][data-action="dispute.status_changed"]');
  await expect(outcome).toContainText("Mirrored PayPal status");
  await expect(outcome).toContainText("Resolved: RESOLVED_WITH_PAYOUT");
  const sent = page.locator('[data-testid="audit-row"][data-action="action.sent"]');
  await expect(sent).toContainText("Sent reply with evidence to PayPal");
  await expect(sent).toContainText("ca51fc56edb2d");
  await expect(page.locator('[data-testid="audit-row"][data-action="action.approved"]')).toContainText("You");
  await expect(page.locator('[data-testid="audit-row"][data-action="action.proposed"]')).toContainText(
    "Agent",
  );
  await expect(page.getByRole("button", { name: /edit|delete|remove/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /edit|delete|remove|export/i })).toHaveCount(0);
  // the expanded detail is plain text
  await sent.getByRole("button", { name: "Details" }).click();
  await expect(sent.getByTestId("audit-detail")).toContainText("debugId");
  await capture(page, "en-audit");

  // filters: actor, kind, ID search, no match → "Clear filters"
  await page.getByTestId("filter-actor").selectOption("agent");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-action", "action.proposed");
  await page.getByTestId("filter-actor").selectOption("");
  await page.getByTestId("filter-kind").selectOption("sandbox");
  await expect(page.getByTestId("filtered-empty")).toContainText("No entries match these filters.");
  await capture(page, "en-audit-filtered-empty");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByTestId("filter-q").fill("ca51fc56edb2d");
  await page.getByTestId("filter-q").press("Enter");
  // the debug_id is on the PayPal call and on the action's success row
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-action")))).toEqual([
    "action.succeeded",
    "action.sent",
  ]);
  await page.getByTestId("filter-q").fill(s.paypalDisputeId);
  await page.getByTestId("filter-q").press("Enter");
  await expect(rows.first()).toHaveAttribute("data-action", "dispute.status_changed");
  await expect(page.getByTestId("audit-row").filter({ hasText: "demo" })).toHaveCount(0);
});

test("/hi/audit renders the HI strings; the empty state's sentence (EN and HI)", async ({ page }) => {
  test.setTimeout(180_000);
  await demoWorkspace(page, "hi");
  await page.goto("/hi/audit");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ऑडिट लॉग");
  await expect(page.getByText("आपके वर्कस्पेस का हर काम, पुरानी प्रविष्टियाँ भी।")).toBeVisible();
  await expect(page.getByTestId("audit-row").first()).toBeVisible();
  await expect(page.getByTestId("audit-actor").first()).toHaveText("Cleared");
  await expect(page.getByText("डेमो वर्कस्पेस बना")).toBeVisible();
  // nothing from the EN audit strings leaks into /hi (IDs, codes and digits stay Latin by design)
  const main = await page.locator("main").innerText();
  for (const en of [
    "Audit log",
    "Every action",
    "Filter",
    "Actor",
    "Load older",
    "Details",
    "Agent",
    "You",
  ]) {
    expect(main).not.toContain(en);
  }
  await expect(page.getByText("The audit log fills in as the agent proposes")).toHaveCount(0);
  await capture(page, "hi-audit");

  // the empty state (a workspace with no entries at all)
  const empty = { items: [], next: null, workspace: { timezone: "Asia/Kolkata" } };
  await page.route("**/api/audit*", (route) => route.fulfill({ json: empty }));
  await page.goto("/hi/audit");
  await expect(page.getByTestId("empty-state")).toHaveText(
    "अभी कुछ नहीं। हर प्रस्ताव, मंज़ूरी और PayPal कॉल यहाँ दर्ज होगी।",
  );
  await capture(page, "hi-audit-empty");
  await page.goto("/en/audit");
  await expect(page.getByTestId("empty-state")).toHaveText(
    "Nothing yet. Every proposal, approval and PayPal call will be recorded here.",
  );
  await capture(page, "en-audit-empty");
  await page.unroute("**/api/audit*");
});
