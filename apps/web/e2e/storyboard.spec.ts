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
//     estimate and source (M3-01/02). The video-pool row (docs/runbooks/review-hold-pool.md) is assigned to
//     this run's workspace by the operator: the spec prints `storyboard workspace <uuid>` and waits up to
//     20 min for the hold. Then the seller declares it goods (her declaration, never PayPal's: BL-01
//     6570499264, option A), sees route advice and files tracking through the approval (real 2xx debug_id);
//     PayPal's review estimate stays
//   3 (1:05–1:50) the chargeback lands, the capture flips to PENDING / BUYER_COMPLAINT, the bell counts it
//     (M3-08), the agent's draft is approved and filed (2xx debug_id), the labelled "Simulate PayPal's
//     decision (sandbox only)" runs, the case reads RESOLVED_WITH_PAYOUT and the capture COMPLETED
//   4 (1:50–2:15) the audit log (proposal by the agent, approval by the seller) and the cash calendar
//     (M3-05) rendered by Bryntum in the browser, with no GTM / bryntum.com request
//   5 the guided Completed step (M3-04): the seller declares the $120 logo payment's (still open) hold a
//     service, records it through the secondary trackers-batch path ("Effect on release unconfirmed",
//     approved, 2xx debug_id: M3-GATE check 4) and confirms Completed. It runs between 3a and 3b, while the
//     hold is still declarable
// M3-GATE check 9: the run starts in a fresh, incognito-like context with no stored state and no keys
// (`expectPrivateWindow`), so it is also the judge path from "Try as demo seller".
// Soft assertions on scene 2 keep a missing hold from stopping the dispute path.
//
// Not automated (ticket scope): the owner's approval of the review-hold order as the sandbox buyer (P-52)
// and the operator's pool:assign.
// The seller's Approve click on the dispute reply is scripted here on the synthetic demo seller, as in
// judge-dispute.live.spec.ts; in the recording (M5-02) the owner clicks it on camera.
//
// Output (never in the repo): screenshots and `run.json` (scene marks, sandbox ids, sync sources) in
// $TMPDIR/m3-11-storyboard/. The chosen screenshots are copied to docs/evidence/ by hand.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HoldDetailSchema,
  PaymentsResponseSchema,
  ScenarioViewSchema,
  type HoldDetail,
  type PaymentItem,
  type ScenarioView,
} from "@cleared/core";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ActionViewSchema, DisputeDetailSchema, type DisputeDetail } from "../src/lib/dispute-view.ts";
import en from "../messages/en.json" with { type: "json" };

const deployed = (process.env["E2E_BASE_URL"] ?? "") !== "";
const OUT = join(process.env["TMPDIR"] ?? "/tmp", "m3-11-storyboard");
const SAMPLES = new URL("../../../fixtures/samples/evidence/", import.meta.url);
const MIN = 60_000;
const t = en.scenario;

/** Synthetic: the scenario's client (fixtures/scenario/scope-chat.txt), never a real person. */
const CLIENT_NAME = "Northwind Tea Co.";
/** Synthetic tracking for the declared-goods hold (sandbox; the carrier is on PayPal's list). */
const TRACKING = { carrier: "IND_DELHIVERY", number: "CLRM311001" } as const;
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
  /** other sandbox ids and refs (review-hold capture, tracking debug_id, …) */
  ids: Record<string, string>;
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
  ids: {},
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
  // the operator assigns the video-pool review hold to this workspace now (pool:assign, runbook step 5)
  console.log(`storyboard workspace ${run.workspaceId}`);
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

/** PayPal's review estimate, unchanged by any declaration (ADR 0017 addendum 3). */
async function expectReviewEstimate(page: Page): Promise<void> {
  const est = page.getByTestId("estimated-date").first();
  await expect.soft(est).toHaveAttribute("data-rule", "payment_review");
  await expect.soft(est).not.toContainText("courier");
}

/** Scene 2b: the seller declares the review hold goods, then files tracking through the approval. */
async function declareGoodsAndTrack(page: Page, holdId: string, notes: string[]): Promise<void> {
  await page.goto(`/en/holds/${holdId}`);
  const decl = page.getByTestId("declaration");
  await decl.getByTestId("declare-goods").check();
  await decl.getByTestId("declare-save").click();
  await expect(decl.getByTestId("declared-line")).toHaveText("You marked this as goods");
  await expect(page.getByTestId("route-advice-full")).toBeVisible();
  await expectReviewEstimate(page);
  await shot(page, "s2-goods-route-advice");
  const card = page.getByTestId("approval-card");
  await card.getByTestId("carrier-select").selectOption(TRACKING.carrier);
  await card.getByTestId("tracking-number").fill(TRACKING.number);
  await card.getByTestId("tracking-review-button").click();
  await expect(card.getByTestId("tracking-review")).toContainText("add_tracking");
  await card.getByTestId("tracking-approve").click();
  await page.getByTestId("tracking-send").click();
  mark("tracking_approved");
  await expect(page.getByTestId("tracking-filed")).toBeVisible({ timeout: 3 * MIN });
  const debug = (await page.getByTestId("tracking-debug-id").textContent()) ?? "";
  run.ids["tracking_debug_id"] = /debug_id (\w+)/.exec(debug)?.[1] ?? "";
  expect(run.ids["tracking_debug_id"]).not.toBe("");
  await expectReviewEstimate(page);
  notes.push(
    `tracking filed: ${TRACKING.carrier} ${TRACKING.number}, debug_id ${run.ids["tracking_debug_id"]}`,
  );
  await shot(page, "s2-tracking-filed");
  mark("tracking_filed");
}

async function sceneHolds(page: Page, notes: string[]): Promise<void> {
  // the video-pool review hold arrives once the operator has run pool:assign for this workspace
  let review: PaymentItem | undefined;
  try {
    review = await waitForPayment(page, (p) => p.hold?.reason === "PENDING_REVIEW", 20 * MIN);
  } catch {
    review = undefined;
  }
  expect.soft(review, "a real PENDING / PENDING_REVIEW hold (video pool, pool:assign)").toBeDefined();
  if (review?.hold === null || review?.hold === undefined) return;
  run.ids["review_capture"] = review.captureId;
  run.sources["review_hold"] = review.source;
  mark("review_hold_seen");
  await page.goto("/hi/holds");
  await expect(page.locator(`[data-testid="hold-row"][data-hold="${review.hold.id}"]`)).toContainText(
    "PENDING_REVIEW",
  );
  await shot(page, "s2-hi-holds-inbox");
  await page.goto(`/hi/holds/${review.hold.id}`);
  const d = page.getByTestId("hold-detail");
  await expect.soft(d.getByTestId("explanation-summary")).toHaveAttribute("lang", "hi", { timeout: 3 * MIN });
  await expect.soft(d.getByTestId("estimated-date").first()).toHaveAttribute("data-rule", "payment_review");
  await expect.soft(d.getByTestId("source-link").first()).toHaveAttribute("href", /^https:\/\//);
  await shot(page, "s2-hi-hold-detail");
  mark("hi_explained");
  await declareGoodsAndTrack(page, review.hold.id, notes);
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
  // the held row (PENDING / BUYER_COMPLAINT), not the loading skeleton
  await expect(page.locator(`[data-testid="payment-row"][data-dispute="${run.disputeId}"]`)).toHaveAttribute(
    "data-status",
    "PENDING",
    { timeout: MIN },
  );
  await shot(page, "s3-held-bell");
  await page.getByTestId("notification-bell").click();
  await shot(page, "s3-bell-panel");
  await page.keyboard.press("Escape");
  notes.push(
    "email alert: demo workspaces are in-app only (M3-08 handoff); email needs an allowlisted owner workspace",
  );

  // the calendar while the dispute is open: a reply-deadline row exactly when PayPal gave a due date. The
  // sandbox chargeback has none (`seller_response_due_date` absent: "PayPal gives no reply date"), so the
  // calendar must not invent one.
  const due = (await detail(page)).dispute.dueDate;
  notes.push(`dispute due date from PayPal: ${due ?? "none"}`);
  await page.goto("/en/calendar");
  // soft: a calendar failure is scene 4's, and must not stop the dispute path
  await expect
    .soft(page.locator('[data-testid="cash-table-row"][data-kind="dispute_deadline"]'))
    .toHaveCount(due === null ? 0 : 1, { timeout: MIN });
  await shot(page, "s3-calendar-deadline");

  await approveDraft(page);
}

async function sceneDecision(page: Page): Promise<void> {
  // the labelled sandbox decision, on the dispute page
  await page.goto(`/en/disputes/${run.disputeId}`);
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

/** Hosts the calendar page called other than the app's own (the trial's GTM question, BL-01 6491378837). */
function thirdParty(page: Page): string[] {
  const own = new URL(run.baseUrl).hostname;
  const out: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && u.hostname !== own) out.push(u.hostname);
  });
  return out;
}

async function sceneCalendarAudit(page: Page, notes: string[]): Promise<void> {
  await page.goto("/en/audit");
  // the dispute reply's own rows (they carry its dispute id): scene 5's seller-proposed Completed record is
  // newer, so the newest row of each action is not the reply's
  const row = (a: string) =>
    page.locator(`[data-testid="audit-row"][data-action="${a}"]`).filter({ hasText: run.disputeId });
  await expect(row("action.proposed").first()).toContainText("Agent", { timeout: MIN });
  await expect(row("action.approved").first()).toContainText("You");
  await expect(row("action.sent").first()).toContainText(run.debugId);
  await shot(page, "s4-audit");
  mark("audit");
  await page.setViewportSize({ width: 1440, height: 900 });
  const calls = thirdParty(page);
  await page.goto("/en/calendar");
  // the Bryntum month view rendered events in a real browser
  await expect(page.locator(".cash-bryntum [data-event-id]").first()).toBeAttached({ timeout: MIN });
  await expect(page.locator('[data-testid="cash-table-row"][data-kind="released"]').first()).toBeAttached({
    timeout: MIN,
  });
  await page.waitForLoadState("networkidle");
  await shot(page, "s4-calendar");
  const hosts = [...new Set(calls)].sort();
  run.ids["calendar_third_party_hosts"] = hosts.join(",");
  notes.push(`calendar third-party hosts: ${hosts.length === 0 ? "none" : hosts.join(", ")}`);
  expect(hosts.filter((h) => /googletagmanager|google-analytics|bryntum\.com/.test(h))).toEqual([]);
  mark("calendar");
}

async function holdDetail(page: Page, holdId: string): Promise<HoldDetail> {
  const res = await page.request.get(`/api/holds/${holdId}`);
  expect(res.status()).toBe(200);
  return HoldDetailSchema.parse(await res.json());
}

/**
 * Scene 5 secondary (M3-GATE check 4, M3-04's flow): the trackers-batch record, always labelled "Effect on
 * release unconfirmed". Open → review the exact payload → approve → send; the worker's PayPal write answers
 * 2xx with a debug_id, and the label stays.
 */
async function recordCompleted(page: Page, holdId: string, notes: string[]): Promise<void> {
  const badge = en.holds.completed.api.badge;
  const record = page.getByTestId("guided-completed").getByTestId("record-completed");
  await expect(record.getByTestId("unconfirmed-badge")).toHaveText(badge);
  await record.getByTestId("record-toggle").click();
  await record.getByTestId("record-review-button").click();
  const payload = record.getByTestId("record-payload");
  await expect(payload).toContainText("record_service_completed");
  await expect(payload).toContainText(run.captureId);
  await expect(payload).toContainText("COMPLETED");
  await shot(page, "s5-record-review");
  await record.getByTestId("record-review").getByTestId("record-approve").click();
  await expect(page.getByTestId("record-confirm")).toBeVisible();
  await page.getByTestId("record-send").click();
  mark("record_approved");
  // settle: recorded (2xx), or failed / unknown, which fail below with PayPal's refusal
  await expect
    .poll(async () => (await holdDetail(page, holdId)).hold.completed?.record.state, {
      timeout: 3 * MIN,
      intervals: [3_000],
    })
    .not.toMatch(/^(none|proposed|recording)$/);
  const rec = (await holdDetail(page, holdId)).hold.completed?.record;
  expect(rec?.state, `record refused: ${rec?.refusal ?? "none"}`).toBe("recorded");
  const res = await page.request.get(`/api/actions/${rec?.actionId ?? ""}`);
  expect(res.status()).toBe(200);
  const action = ActionViewSchema.parse(((await res.json()) as { action: unknown }).action);
  expect(action).toMatchObject({ kind: "record_service_completed", state: "succeeded", createdBy: "seller" });
  const status = Number(action.execution?.paypalStatus ?? "0");
  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
  const debugId = action.execution?.paypalDebugId ?? "";
  expect(debugId).not.toBe("");
  expect(rec?.debugId).toBe(debugId);
  await expect(record.getByTestId("record-recorded")).toContainText(`debug_id ${debugId}`, { timeout: MIN });
  await expect(record.getByTestId("unconfirmed-badge")).toHaveText(badge);
  run.ids["record_completed_debug_id"] = debugId;
  run.ids["record_completed_status"] = String(status);
  notes.push(`trackers-batch record (effect on release unconfirmed): ${String(status)}, debug_id ${debugId}`);
  await shot(page, "s5-record-recorded");
  mark("record_recorded");
}

/**
 * Scene 5: the $120 logo redesign is a service; the seller declares its (dispute) hold so, records it with
 * PayPal's API (the secondary, unconfirmed path), and confirms Completed (the guided step).
 */
async function sceneCompleted(page: Page, notes: string[]): Promise<void> {
  const held = (await payments(page)).find((p) => p.captureId === run.captureId);
  const holdId = held?.hold?.id ?? "";
  expect(holdId, "the scenario payment's open hold").not.toBe("");
  await page.goto(`/en/holds/${holdId}`);
  const decl = page.getByTestId("declaration");
  await decl.getByTestId("declare-service").check();
  await decl.getByTestId("declare-save").click();
  await expect(decl.getByTestId("declared-line")).toHaveText("You marked this as a service");
  const slot = page.getByTestId("guided-completed");
  await expect(slot).toBeVisible();
  await shot(page, "s5-completed-step");
  await recordCompleted(page, holdId, notes);
  await slot.getByTestId("completed-submit").click();
  await expect(slot.getByTestId("completed-done")).toBeVisible({ timeout: MIN });
  await expect(page.getByTestId("completed-toast")).toHaveText("Saved. Your estimate hasn't changed.");
  notes.push(`declared service + Completed on hold ${holdId} (dispute hold; PayPal's state unchanged)`);
  await shot(page, "s5-completed-done");
  mark("completed");
}

/**
 * M3-GATE check 9: the judge path starts in a private window with no keys. The run's own browser context is
 * Playwright's fresh, incognito-like one; this proves it carries nothing in: no stored state, cookies or
 * storage, no credentials or extra headers from the config, and no session before "Try as demo seller".
 * The same run then is the judge path (demo seller → dispute scenario → RESOLVED_WITH_PAYOUT → capture
 * COMPLETED, scenes 1, 3a, 3b), so the gate spends one demo workspace (quota: 3 per IP per day), not two.
 */
async function expectPrivateWindow(context: BrowserContext, page: Page): Promise<void> {
  const use = test.info().project.use;
  expect(use.storageState, "no stored state in the config").toBeUndefined();
  expect(use.httpCredentials, "no credentials in the config").toBeUndefined();
  expect(use.extraHTTPHeaders, "no extra headers (no keys) in the config").toBeUndefined();
  expect(await context.storageState()).toEqual({ cookies: [], origins: [] });
  // no session yet: the workspace API refuses until "Try as demo seller"
  const before = await page.request.get("/api/workspace");
  expect(before.status()).toBe(401);
  mark("private_window");
}

test("storyboard dry run: scenes 1–5 on the deployed app", async ({ page, browser, context }) => {
  test.skip(!deployed, "deployed only: set E2E_BASE_URL (M3-11 runs against production)");
  test.setTimeout(120 * MIN);
  mark("start");
  await expectPrivateWindow(context, page);
  await scene("1 proof pack", (n) => sceneProof(page, browser, n));
  await scene("2 held-money inbox", (n) => sceneHolds(page, n));
  await scene("3a dispute lands, reply filed", (n) => sceneDispute(page, n));
  // scene 5 runs while the case waits for the decision: the hold is still open (declarable) only now
  await scene("5 guided Completed", (n) => sceneCompleted(page, n));
  await scene("3b decision to release", () => sceneDecision(page));
  await scene("4 calendar and audit", (n) => sceneCalendarAudit(page, n));
  mark("end");
  save();
});
