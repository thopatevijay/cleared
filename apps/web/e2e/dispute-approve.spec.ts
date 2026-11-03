// M2-09 E2E (local, fixture-backed): open the dispute → review the M2-07 draft (recorded notes, real
// compiled PDF) → deselect an item (new fingerprint; a second tab that reviewed the old one is refused
// APPROVAL_HASH_MISMATCH) → the count turns to error above 2000 and disables Approve → keyboard-only
// approve → the worker files it on the msw stub (recorded M0-05 responses, never the sandbox) → filed with
// PayPal's debug_id → the mirrored outcome reads exactly "Resolved; you keep the money (PayPal covered the
// case)". Also: axe, 360 px, HI, the list, and the ui-reviewer captures of each state.
import { expect, test } from "@playwright/test";
import { e2eDisputeIds, recordedNotes } from "../test/support/dispute-seed.ts";
import { firstViewOff } from "./support/journey.ts";
import {
  approveByKeyboard,
  capture,
  demoWorkspace,
  inFlight,
  local,
  PAYOUT_EN,
  seed,
  sql,
} from "./support/disputes.ts";

test.describe.configure({ mode: "serial" });
test.skip(!local, "local only: the msw stub stands in for PayPal");

test("review the draft, revise, approve, filed, outcome (EN)", async ({ page, context }) => {
  test.setTimeout(420_000);
  const ws = await demoWorkspace(page);
  const s = await seed(ws);
  const url = `/en/disputes/${s.disputeRowId}`;

  // the list
  await page.goto("/en/disputes");
  const row = page.getByTestId("dispute-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Item not as described");
  await expect(row).toContainText("WAITING_FOR_SELLER_RESPONSE");
  await expect(row.getByTestId("deadline-badge")).toBeVisible();
  await capture(page, "en-list");

  // a second tab reviews the original draft and opens the confirm dialog (polling pauses while it is open)
  const stale = await context.newPage();
  await stale.goto(url);
  const oldFp = s.payloadSha256.slice(0, 8);
  await expect(stale.getByTestId("fingerprint")).toHaveText(oldFp);
  await stale.getByTestId("approve").click();
  await expect(stale.getByTestId("approve-dialog")).toBeVisible();

  // the seller reviews the draft: notes as text, count, items, PDF, fingerprint
  await page.goto(url);
  await expect(page.getByTestId("notes")).toHaveValue(recordedNotes());
  await expect(page.getByTestId("notes-count")).toContainText(` / 2000`);
  await expect(page.getByTestId("evidence-toggle")).toHaveCount(3);
  await expect(page.getByTestId("pdf")).toContainText("Reply evidence.pdf");
  await expect(page.getByTestId("allowed-actions")).toHaveText("accept claim, provide evidence");
  await capture(page, "en-detail-proposed");

  // deselecting an item → draft/revise → a new fingerprint (the old one struck through)
  await page.getByTestId("evidence-toggle").nth(2).uncheck();
  await expect(page.getByTestId("fingerprint")).not.toHaveText(oldFp, { timeout: 20_000 });
  await expect(page.getByTestId("fingerprint-old")).toContainText(oldFp);
  const newFp = (await page.getByTestId("fingerprint").textContent()) ?? "";
  expect(newFp).toMatch(/^[0-9a-f]{8}$/);

  // the stale tab approves the hash it reviewed → refused, nothing approved
  await stale.getByTestId("approve-send").click();
  await expect(stale.getByTestId("approve-refusal")).toHaveText(
    "This draft changed. Review the new version and approve again.",
  );
  await expect(stale.getByTestId("fingerprint")).toHaveText(newFp, { timeout: 15_000 });
  await stale.close();
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "proposed");

  // over 2000 characters: the count turns to error and Approve is disabled (no revise is sent)
  await page.getByTestId("notes").fill("a".repeat(2001));
  await expect(page.getByTestId("notes-count")).toHaveAttribute("data-over", "true");
  await expect(page.getByTestId("notes-count")).toContainText("Over the 2000-character limit");
  await expect(page.getByTestId("approve")).toBeDisabled();
  await expect(page.getByTestId("fingerprint")).toHaveText(newFp);
  await capture(page, "en-detail-over-limit");

  // back to the recorded notes → a fresh fingerprint, Approve enabled again
  await page.getByTestId("notes").fill(recordedNotes());
  await expect(page.getByTestId("fingerprint")).not.toHaveText(newFp, { timeout: 20_000 });
  await expect(page.getByTestId("approve")).toBeEnabled({ timeout: 20_000 });

  // keyboard-only approve → filed → PayPal's outcome
  await approveByKeyboard(page);
  await expect(page.getByTestId("filing-status")).toContainText(
    "Filed after your approval · PayPal debug_id ca51fc56edb2d",
  );
  await expect(page.getByTestId("dispute-outcome")).toContainText("Hold released: payment is Completed", {
    timeout: 60_000,
  });
  await expect(page.locator("body")).not.toContainText(/\bwon\b/i);
  await expect(page.getByTestId("approve")).toHaveCount(0);
  await capture(page, "en-detail-resolved");
});

test("dispute screens in HI, the 'drafting' state and a failed filing (ui-reviewer states)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const ws = await demoWorkspace(page, "hi");
  const s = await seed(ws);
  await page.goto(`/hi/disputes/${s.disputeRowId}`);
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await expect(page.getByTestId("approve")).toHaveText("मंज़ूर करें और भेजें");
  await capture(page, "hi-detail-proposed");

  // a failed filing, for real: PayPal refuses the evidence (recorded 422, debug_id ca51fb6196f52); the trail
  // shows the approval, the checks and the refused send; "Review and approve again" proposes it again
  const rejected = await seed(ws, { ids: e2eDisputeIds("FA11") });
  await page.goto(`/en/disputes/${rejected.disputeRowId}`);
  await approveByKeyboard(page, "failed");
  await expect(page.getByTestId("filing-refusal")).toHaveText("PayPal refused the reply.");
  await expect(page.getByTestId("filing-status")).toContainText("ca51fb6196f52");
  await expect(page.locator('[data-testid="audit-trail"] [data-action="action.approved"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="audit-trail"] [data-action="action.failed"]')).toHaveCount(1);
  await capture(page, "en-detail-failed");
  await page.goto(`/hi/disputes/${rejected.disputeRowId}`);
  await expect(page.getByTestId("filing-refusal")).toBeVisible();
  await capture(page, "hi-detail-failed");
  await page.goto(`/en/disputes/${rejected.disputeRowId}`);
  await page.getByTestId("repropose").click();
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "proposed", {
    timeout: 20_000,
  });

  // no draft yet: "drafting"
  const bare = await seed(ws, { draft: false });
  await page.goto(`/en/disputes/${bare.disputeRowId}`);
  await expect(page.getByTestId("drafting")).toBeVisible();
  await capture(page, "en-detail-drafting");

  // error and loading (M4-08: without the server-rendered first view)
  await firstViewOff(page);
  await page.route("**/api/disputes/**", (route) =>
    route.fulfill({
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000500",
      },
      body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
    }),
  );
  await page.goto(`/en/disputes/${s.disputeRowId}`);
  await expect(page.getByTestId("error-panel")).toBeVisible();
  await capture(page, "en-detail-error");
  await page.unroute("**/api/disputes/**");
  await page.route("**/api/disputes/**", () => undefined);
  await page.goto(`/en/disputes/${s.disputeRowId}`);
  await expect(page.getByTestId("loading")).toBeVisible();
  await page.waitForTimeout(3_500);
  await capture(page, "en-detail-loading");
  await page.unroute("**/api/disputes/**");
  await page.setExtraHTTPHeaders({});

  // empty list
  await demoWorkspace(page);
  await page.goto("/en/disputes");
  await expect(page.getByTestId("empty-state")).toContainText("No disputes");
  await capture(page, "en-list-empty");
  expect(PAYOUT_EN).not.toMatch(/won/);
});

test("the remaining spec states: confirm dialog, accept claim, kill switch, too late, unavailable, sending, checking, deadline badges", async ({
  page,
}) => {
  test.setTimeout(400_000);
  const ws = await demoWorkspace(page);
  const s = await seed(ws);
  const url = `/en/disputes/${s.disputeRowId}`;

  // the Approve confirm alertdialog (initial focus "Go back")
  await page.goto(url);
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("approve-dialog")).toBeVisible();
  await expect(page.getByTestId("approve-dialog").getByRole("button", { name: "Go back" })).toBeFocused();
  await capture(page, "en-detail-confirm-dialog");
  await page.keyboard.press("Escape");

  // "Other options" → Accept claim, behind the typed confirmation
  await page.getByText("Other options").click();
  await page.getByRole("button", { name: "Accept claim…" }).click();
  await expect(page.getByText("Type 120.00 USD to confirm")).toBeVisible();
  await expect(page.getByTestId("accept-confirm")).toBeDisabled();
  await page.getByTestId("accept-typed").fill("120.00 usd");
  await expect(page.getByTestId("accept-confirm")).toBeDisabled();
  await capture(page, "en-detail-accept-claim");
  await page.getByTestId("accept-typed").fill("120.00 USD");
  await expect(page.getByTestId("accept-confirm")).toBeEnabled();
  await page.keyboard.press("Escape");

  // kill switch on (local database only; reset at once)
  await sql(
    "insert into platform_flags (id, agent_kill_switch) values (1, true) on conflict (id) do update set agent_kill_switch = true",
    [],
  );
  try {
    await page.goto(url);
    await expect(page.getByTestId("kill-banner")).toHaveText(
      "Sending to PayPal is paused. Your draft is saved.",
    );
    await expect(page.getByTestId("approve")).toBeDisabled();
    await capture(page, "en-detail-kill-switch");
  } finally {
    await sql("update platform_flags set agent_kill_switch = false where id = 1", []);
  }

  // Cleared's own in-flight states, mirrored in the stepper
  await inFlight(ws, s, "executing");
  await page.goto(url);
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "executing");
  await capture(page, "en-detail-sending");
  const checking = await seed(ws);
  await inFlight(ws, checking, "unknown");
  await page.goto(`/en/disputes/${checking.disputeRowId}`);
  await expect(page.getByTestId("filing-status")).toContainText(
    "Checking with PayPal: the reply may have been received.",
  );
  await capture(page, "en-detail-checking");

  // too late: closed_for_action makes the draft read only
  const late = await seed(ws);
  await sql(
    "update disputes set deadline_state = 'closed_for_action', seller_response_due_date = now() + interval '30 minutes' where id = $1",
    [late.disputeRowId],
  );
  await page.goto(`/en/disputes/${late.disputeRowId}`);
  await expect(page.getByTestId("approve-unavailable")).toHaveText("Too late to reply here.");
  await capture(page, "en-detail-too-late");

  // draft unavailable (budget reached): the PayPal link and the pack's items
  const none = await seed(ws, { draft: false });
  await sql(
    "insert into audit_log (workspace_id, actor, action, detail) values ($1, 'system', 'dispute_draft.unavailable', jsonb_build_object('disputeId', $2::text, 'code', 'budget_exceeded'))",
    [ws, none.disputeRowId],
  );
  await page.goto(`/en/disputes/${none.disputeRowId}`);
  await expect(page.getByTestId("draft-unavailable")).toContainText(
    "Draft unavailable. You can still reply in PayPal yourself.",
  );
  await expect(page.getByTestId("draft-unavailable").getByTestId("evidence-citation")).toHaveCount(3);
  await capture(page, "en-detail-unavailable");

  // the list's deadline badges: t72, t24, closed_for_action
  await sql(
    "update disputes set deadline_state = 't72', seller_response_due_date = now() + interval '50 hours' where id = $1",
    [s.disputeRowId],
  );
  await sql(
    "update disputes set deadline_state = 't24', seller_response_due_date = now() + interval '18 hours' where id = $1",
    [none.disputeRowId],
  );
  await page.goto("/en/disputes");
  await expect(page.locator('[data-testid="deadline-badge"][data-state="t72"]')).toHaveText("Due in 2 days");
  await expect(page.locator('[data-testid="deadline-badge"][data-state="t24"]')).toContainText("hours");
  await expect(page.locator('[data-testid="deadline-badge"][data-state="closed_for_action"]')).toHaveText(
    "Too late to reply here",
  );
  await capture(page, "en-list-deadlines");
  await page.goto("/hi/disputes");
  await capture(page, "hi-list-deadlines");
});
