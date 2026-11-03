// M3-11 storyboard dry run (PROJECT.md §2) against a deployed Cleared (E2E_BASE_URL, e.g. production on
// Render). Deployed only: there is no local stack and no stub, every PayPal and OpenAI call is the deployed
// service's own, on the PayPal sandbox. The spec holds no credential and reads no database.
//
// One synthetic demo seller ("Try as demo seller") runs the scenes in order, each a `test.step` with its
// wall time:
//   1 (0:20–0:45) the $120 card payment arrives (M2-10 scenario: real sandbox order + capture); the pack holds
//     the scope chat and the delivery PDF (the scenario's M2-01 intake), the seller pastes a client message
//     and uploads a screenshot on the pack page, the AI scope check returns verdicts with verbatim quotes
//     (M2-04), the client confirms the acknowledgement link from a second browser (M3-06), the scope
//     snapshot downloads (M3-07)
//   2 (0:45–1:05) a real PENDING / PENDING_REVIEW hold in the held-money inbox, explained in Hindi with its
//     estimate and source (M3-01/02; needs a review-hold pool row: docs/runbooks/review-hold-pool.md), and a
//     goods hold with route advice and the tier badge (M3-03)
//   3 (1:05–1:50) the chargeback lands, the capture flips to PENDING / BUYER_COMPLAINT, the bell counts it
//     (M3-08), the agent's draft is approved and filed (2xx debug_id), the labelled "Simulate PayPal's
//     decision (sandbox only)" runs, the case reads RESOLVED_WITH_PAYOUT and the capture COMPLETED
//   4 (1:50–2:15) the cash calendar (M3-05) and the audit log (proposal by the agent, approval by the seller)
//   5 the guided Completed step (M3-04) on a service hold
// Scenes 2 and 5 use soft assertions: a missing hold fails the run without stopping scenes 3–4.
//
// Not automated (ticket scope): the owner's approval of the review-hold order as the sandbox buyer (P-52).
// The seller's Approve click on the dispute reply is scripted here on the synthetic demo seller, as in
// judge-dispute.live.spec.ts; in the recording (M5-02) the owner clicks it on camera.
//
// Output (never in the repo): screenshots and `run.json` (scene marks, sandbox ids, sync sources) in
// $TMPDIR/m3-11-storyboard/. The chosen screenshots are copied to docs/evidence/ by hand.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PaymentsResponseSchema,
  ScenarioViewSchema,
  type PaymentItem,
  type ScenarioView,
} from "@cleared/core";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { DisputeDetailSchema, type DisputeDetail } from "../src/lib/dispute-view.ts";
import en from "../messages/en.json" with { type: "json" };

const deployed = (process.env["E2E_BASE_URL"] ?? "") !== "";
const OUT = join(process.env["TMPDIR"] ?? "/tmp", "m3-11-storyboard");
const SAMPLES = new URL("../../../fixtures/samples/evidence/", import.meta.url);
const MIN = 60_000;
const t = en.scenario;

/** Synthetic: the scenario's client (fixtures/scenario/scope-chat.txt), never a real person. */
const CLIENT_NAME = "Northwind Tea Co.";
const PASTED_CHAT =
  "[2026-10-19 09:02] Northwind Tea Co.: The brand guide colour codes match our packaging. Thanks, Meera.";

interface Run {
  baseUrl: string;
  workspaceId: string;
  scenarioId: string;
  captureId: string;
  paymentId: string;
  disputeId: string;
  debugId: string;
  marks: Record<string, string>;
  scenes: Record<string, { start: string; end: string; seconds: number; notes: string[] }>;
  sources: Record<string, string>;
  timeline: ScenarioView["timeline"];
}

const run: Run = {
  baseUrl: process.env["E2E_BASE_URL"] ?? "",
  workspaceId: "",
  scenarioId: "",
  captureId: "",
  paymentId: "",
  disputeId: "",
  debugId: "",
  marks: {},
  scenes: {},
  sources: {},
  timeline: [],
};

function mark(name: string): void {
  run.marks[name] = new Date().toISOString();
  console.log(`storyboard ${name} ${run.marks[name] ?? ""}`);
}

/** Runs one scene as a test step and records its wall time. */
async function scene(name: string, body: (notes: string[]) => Promise<void>): Promise<void> {
  const start = new Date();
  const notes: string[] = [];
  try {
    await test.step(name, () => body(notes));
  } finally {
    const end = new Date();
    run.scenes[name] = {
      start: start.toISOString(),
      end: end.toISOString(),
      seconds: Math.round((end.getTime() - start.getTime()) / 1000),
      notes,
    };
    save();
  }
}

function save(): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "run.json"), JSON.stringify(run, null, 2));
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

const step = (scope: Page | Locator, key: string) => scope.locator(`[data-step="${key}"]`);

async function scenario(page: Page): Promise<ScenarioView> {
  const res = await page.request.get(`/api/scenarios/${run.scenarioId}`);
  expect(res.status()).toBe(200);
  return ScenarioViewSchema.parse(((await res.json()) as { scenario: unknown }).scenario);
}

async function payments(page: Page): Promise<PaymentItem[]> {
  const res = await page.request.get("/api/payments");
  expect(res.status()).toBe(200);
  return PaymentsResponseSchema.parse(await res.json()).items;
}

async function detail(page: Page): Promise<DisputeDetail> {
  const res = await page.request.get(`/api/disputes/${run.disputeId}`);
  expect(res.status()).toBe(200);
  return DisputeDetailSchema.parse(await res.json());
}

/** Polls the payment list until `pick` finds a row (the dashboard itself polls every 5 s). */
async function waitForPayment(
  page: Page,
  pick: (p: PaymentItem) => boolean,
  timeoutMs: number,
): Promise<PaymentItem> {
  let found: PaymentItem | undefined;
  await expect
    .poll(
      async () => {
        found = (await payments(page)).find(pick);
        return found !== undefined;
      },
      { timeout: timeoutMs, intervals: [5_000] },
    )
    .toBe(true);
  if (found === undefined) throw new Error("unreachable");
  return found;
}

async function gotoPack(page: Page): Promise<void> {
  await page.goto(`/en/payments/${run.paymentId}/pack`);
  await page.locator("[data-testid=intake][data-ready=true]").waitFor();
}

async function addText(page: Page, kind: string, text: string): Promise<void> {
  await page.getByTestId("intake-kind").selectOption(kind);
  await page.getByTestId("intake-text").fill(text);
  await page.getByTestId("intake-add").click();
  await expect(page.getByTestId("intake-added")).toBeVisible();
}

async function addFile(page: Page, kind: string, name: string): Promise<void> {
  await page.getByTestId("intake-kind").selectOption(kind);
  await page.getByTestId("intake-file").setInputFiles(new URL(name, SAMPLES).pathname);
  await page.getByTestId("intake-add").click();
  await expect(page.getByTestId("intake-added")).toBeVisible();
}

/** The client opens the acknowledgement link in a second browser (no session) and confirms. */
async function clientConfirms(browser: Browser, url: string): Promise<void> {
  const ctx = await browser.newContext({ locale: "en-US", timezoneId: "Asia/Kolkata" });
  try {
    const client = await ctx.newPage();
    await client.goto(url);
    await expect(client.getByTestId("ack-scope")).toBeVisible();
    await client.getByLabel("Your name").fill(CLIENT_NAME);
    await client.getByLabel("I agree to this scope").check();
    await client.getByRole("button", { name: "Confirm" }).click();
    await expect(client.getByTestId("ack-success")).toBeVisible();
    await shot(client, "s1-client-ack");
  } finally {
    await ctx.close();
  }
}

async function sceneProof(page: Page, browser: Browser, notes: string[]): Promise<void> {
  await page.goto("/en");
  await page.getByTestId("demo-cta").click();
  await page.waitForURL("**/en/payments");
  run.workspaceId = (
    (await (await page.request.get("/api/workspace")).json()) as { workspace: { id: string } }
  ).workspace.id;
  await page.getByRole("button", { name: t.ctaName }).click();
  await page.waitForURL("**/en/scenario/**");
  run.scenarioId = page.url().split("/").pop() ?? "";
  mark("scenario_started");
  await expect(step(page, "capture")).toHaveAttribute("data-status", "done", { timeout: 5 * MIN });
  const s = await scenario(page);
  run.captureId = s.capture?.captureId ?? "";
  expect(run.captureId).not.toBe("");
  const payment = await waitForPayment(page, (p) => p.captureId === run.captureId, 5 * MIN);
  run.paymentId = payment.id;
  run.sources["payment_arrived"] = payment.source;
  mark("payment_arrived");

  // the scenario's intake (scope chat + delivery PDF), checked by the AI; then the seller adds her own
  await gotoPack(page);
  const banner = page.getByTestId("pack-banner");
  await expect(banner).toHaveAttribute("data-state", "checked", { timeout: 10 * MIN });
  await addText(page, "communication", PASTED_CHAT);
  await addFile(page, "delivery", "screenshot-logo.png");
  await expect(banner).toHaveAttribute("data-state", "checked", { timeout: 10 * MIN });
  await expect(page.getByTestId("verdict-row").first()).toBeVisible();
  await expect(page.getByTestId("quote").first()).toBeVisible();
  const verdicts = await page
    .getByTestId("verdict-row")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-verdict") ?? ""));
  notes.push(`verdicts: ${verdicts.join(", ")}`);
  notes.push(`citations: ${String(await page.getByTestId("citation").count())}`);
  mark("scope_checked");
  await shot(page, "s1-pack-verdicts");

  // client acknowledgement from a second browser
  const ack = page.getByTestId("ack-panel");
  await ack.getByRole("button", { name: /acknowledgement link/ }).click();
  const url = await page.getByTestId("ack-url").inputValue();
  await clientConfirms(browser, url);
  // the seller's panel polls and shows the acceptance, and the pack gains the client_ack item
  await expect(ack).toContainText("Accepted", { timeout: MIN });
  await expect(page.locator("[data-testid=evidence-item][data-kind=client_ack]")).toContainText(
    `Confirmed by ${CLIENT_NAME}`,
  );
  mark("client_ack");

  // scope snapshot
  const snap = page.getByTestId("snapshot-panel");
  await snap.getByRole("button", { name: "Create scope snapshot" }).click();
  await expect(snap.getByTestId("snapshot-download")).toBeVisible({ timeout: 2 * MIN });
  const download = page.waitForEvent("download");
  await snap.getByTestId("snapshot-download").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^scope-snapshot-[0-9a-f]{12}\.pdf$/);
  await file.saveAs(join(OUT, "s1-scope-snapshot.pdf"));
  await shot(page, "s1-pack-ack-snapshot");
  mark("snapshot");
}

async function sceneHolds(page: Page, notes: string[]): Promise<void> {
  const items = await payments(page);
  const review = items.find((p) => p.hold?.reason === "PENDING_REVIEW");
  expect
    .soft(review, "a real PENDING / PENDING_REVIEW hold (review-hold pool, BL-01 6575469150)")
    .toBeDefined();
  if (review?.hold) {
    notes.push(`review hold capture ${review.captureId}`);
    await page.goto("/hi/holds");
    await shot(page, "s2-hi-holds-inbox");
    await page.goto(`/hi/holds/${review.hold.id}`);
    const d = page.getByTestId("hold-detail");
    await expect
      .soft(d.getByTestId("explanation-summary"))
      .toHaveAttribute("lang", "hi", { timeout: 2 * MIN });
    await expect.soft(d.getByTestId("estimated-date")).toBeVisible();
    await expect.soft(d.getByTestId("source-link").first()).toHaveAttribute("href", /^https:\/\//);
    await shot(page, "s2-hi-hold-detail");
  }
  const goods = items.find((p) => p.hold?.type === "goods");
  expect.soft(goods, "a goods hold with route advice (no product path: BL-01 6570499264)").toBeDefined();
  if (goods?.hold) {
    await page.goto(`/en/holds/${goods.hold.id}`);
    await shot(page, "s2-goods-route-advice");
  }
  mark("holds_scene");
}

async function approveDraft(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const d = (await detail(page)).draft;
        return d?.actionKind === "provide_evidence" && d.action?.state === "proposed" && d.allowed;
      },
      { timeout: 15 * MIN, intervals: [5_000] },
    )
    .toBe(true);
  mark("draft_ready");
  const fp = ((await detail(page)).draft?.action?.payload_sha256 ?? "").slice(0, 8);
  await page.goto("/en/payments");
  await page
    .locator(`[data-testid="payment-row"][data-dispute="${run.disputeId}"]`)
    .getByTestId("review-approve")
    .click();
  await page.waitForURL(/\/en\/disputes\/[^/]+#approval$/);
  await expect(page.getByTestId("fingerprint")).toHaveText(fp);
  await shot(page, "s3-approval-card");
  await page.getByTestId("approve").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toContainText(fp);
  await dialog.getByRole("button", { name: en.disputes.confirm.send }).click();
  mark("approved");
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "succeeded", {
    timeout: 5 * MIN,
  });
  const action = (await detail(page)).draft?.action;
  const status = Number(action?.execution?.paypalStatus ?? "0");
  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
  run.debugId = action?.execution?.paypalDebugId ?? "";
  expect(run.debugId).not.toBe("");
  await expect(page.getByTestId("filing-status")).toContainText(`PayPal debug_id ${run.debugId}`);
  await shot(page, "s3-evidence-filed");
  mark("evidence_filed");
}

async function sceneDispute(page: Page, notes: string[]): Promise<void> {
  await page.goto(`/en/scenario/${run.scenarioId}`);
  await expect(step(page, "chargeback")).toHaveAttribute("data-status", "done", { timeout: 10 * MIN });
  const held = await waitForPayment(
    page,
    (p) => p.captureId === run.captureId && p.status === "PENDING" && p.statusReason === "BUYER_COMPLAINT",
    10 * MIN,
  );
  run.sources["capture_held"] = held.source;
  mark("held_buyer_complaint");
  await expect
    .poll(async () => (await scenario(page)).dispute?.disputeId ?? "", { timeout: 10 * MIN })
    .not.toBe("");
  run.disputeId = (await scenario(page)).dispute?.disputeId ?? "";
  mark("dispute_mirrored");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/payments");
  await expect(page.getByTestId("notification-bell")).toHaveAccessibleName(/Notifications, [1-9]\d* unread/, {
    timeout: 5 * MIN,
  });
  await shot(page, "s3-held-bell");
  await page.getByTestId("notification-bell").click();
  await shot(page, "s3-bell-panel");
  await page.keyboard.press("Escape");
  notes.push(
    "email alert: demo workspaces are in-app only (M3-08 handoff); email needs an allowlisted owner workspace",
  );

  // the calendar while the dispute is open: its reply deadline
  await page.goto("/en/calendar");
  await expect(page.locator('[data-testid="cash-table-row"][data-kind="dispute_deadline"]')).toHaveCount(1, {
    timeout: MIN,
  });
  await shot(page, "s3-calendar-deadline");

  await approveDraft(page);

  // the labelled sandbox decision, on the dispute page
  const box = page.getByTestId("dispute-scenario");
  const decide = box.getByRole("button", { name: t.decide });
  await expect(decide).toBeEnabled({ timeout: 20 * MIN });
  mark("decision_offered");
  await shot(page, "s3-decision-control");
  await decide.click();
  await box.getByRole("dialog").getByRole("button", { name: t.confirm }).click();
  mark("decision_requested");
  await expect(page.getByTestId("outcome-text")).toHaveText(en.disputes.outcome.payout, {
    timeout: 25 * MIN,
  });
  mark("resolved");
  await expect(page.locator("body")).not.toContainText(/\bwon\b/i);
  await page.goto(`/en/scenario/${run.scenarioId}`);
  await expect(page.getByText(t.holdReleased)).toBeVisible({ timeout: 15 * MIN });
  mark("hold_released");
  const done = await scenario(page);
  expect(done.dispute).toMatchObject({
    status: "RESOLVED",
    outcome: { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" },
  });
  expect(done.capture?.status).toBe("COMPLETED");
  run.timeline = done.timeline;
  const released = await waitForPayment(
    page,
    (p) => p.captureId === run.captureId && p.status === "COMPLETED",
    5 * MIN,
  );
  run.sources["capture_released"] = released.source;
  await shot(page, "s3-scenario-resolved");
  await page.goto(`/en/disputes/${run.disputeId}`);
  await expect(page.getByTestId("dispute-outcome")).toContainText(en.disputes.outcome.holdReleased);
  await shot(page, "s3-dispute-resolved");
}

async function sceneCalendarAudit(page: Page): Promise<void> {
  await page.goto("/en/calendar");
  await expect(page.locator('[data-testid="cash-table-row"][data-kind="released"]').first()).toBeAttached({
    timeout: MIN,
  });
  await shot(page, "s4-calendar");
  await page.goto("/en/audit");
  const row = (a: string) => page.locator(`[data-testid="audit-row"][data-action="${a}"]`);
  await expect(row("action.proposed").first()).toContainText("Agent", { timeout: MIN });
  await expect(row("action.approved").first()).toContainText("You");
  await expect(row("action.sent").first()).toContainText(run.debugId);
  await shot(page, "s4-audit");
  mark("calendar_audit");
}

async function sceneCompleted(page: Page): Promise<void> {
  const service = (await payments(page)).find((p) => p.hold?.type === "service");
  expect.soft(service, "a service hold with the guided Completed step (BL-01 6570499264)").toBeDefined();
  if (service?.hold) {
    await page.goto(`/en/holds/${service.hold.id}`);
    await shot(page, "s5-completed-step");
  }
}

test("storyboard dry run: scenes 1–5 on the deployed app", async ({ page, browser }) => {
  test.skip(!deployed, "deployed only: set E2E_BASE_URL (M3-11 runs against production)");
  test.setTimeout(90 * MIN);
  mark("start");
  await scene("1 proof pack", (n) => sceneProof(page, browser, n));
  await scene("2 held-money inbox", (n) => sceneHolds(page, n));
  await scene("3 dispute to release", (n) => sceneDispute(page, n));
  await scene("4 calendar and audit", () => sceneCalendarAudit(page));
  await scene("5 guided Completed", () => sceneCompleted(page));
  mark("end");
  save();
});
