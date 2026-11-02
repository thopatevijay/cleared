// M2-10 live judge path (M2-GATE runs it from a clean stack): a demo seller runs the dispute scenario
// against the REAL PayPal sandbox and watches it reach dispute RESOLVED (RESOLVED_WITH_PAYOUT) with the
// capture COMPLETED. Every PayPal step is a real sandbox call: card order + capture with custom_id =
// workspace, process-chargeback, dispute and capture syncs, the evidence filing and the labelled
// "Simulate PayPal's decision (sandbox only)" (adjudicate). M0-05 measured ≈ 21.5 min end to end.
//
// Nothing is written by the test (BL-01 6537797729): the real pipeline builds the proof pack (M2-03 extract,
// M2-04 scope check) and the M2-07 draft with its proposal; the seller opens the dispute from the dashboard's
// "Review and approve" (M2-09), checks the fingerprint and clicks Approve → "Send to PayPal"; the worker's
// `action.execute` re-fetches the dispute, finds the action link and makes the one PayPal write.
// The test only reads: the app's own read APIs and one sandbox GET of the dispute (the evidence types PayPal
// requests, so the draft's evidence type is checked against the reason map exactly).
//
// Live only: E2E_LIVE=1 with the main checkout's .env loaded by path (WORKFLOW.md "Live lines"), so the
// local web and worker start WITHOUT the msw stub (playwright.config.ts). Skipped otherwise.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHttpClient,
  createPayPalDisputesClient,
  createTokenProvider,
  PAYPAL_SANDBOX_BASE_URL,
  VENDOR_TIMEOUTS_MS,
} from "@cleared/adapters";
import { codePoints, mapReason, requestedEvidenceTypes, ScenarioViewSchema, type ScenarioView } from "@cleared/core";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { DisputeDetailSchema, type DisputeDetail, type Draft } from "../src/lib/dispute-view.ts";
import en from "../messages/en.json" with { type: "json" };

const live = process.env["E2E_LIVE"] === "1";
const OUT = fileURLToPath(new URL("../test-results/", import.meta.url));
const MIN = 60_000;
const t = en.scenario;
const PDF_LIMIT = 10_000_000; // PayPal: < 10 MB per file
const CHECKS = ["kill_switch", "payload_hash", "blob_hash", "ownership", "action_link", "deadline"];

async function scenario(page: Page, id: string): Promise<ScenarioView> {
  const res = await page.request.get(`/api/scenarios/${id}`);
  expect(res.status()).toBe(200);
  return ScenarioViewSchema.parse(((await res.json()) as { scenario: unknown }).scenario);
}

async function detail(page: Page, disputeId: string): Promise<DisputeDetail> {
  const res = await page.request.get(`/api/disputes/${disputeId}`);
  expect(res.status()).toBe(200);
  return DisputeDetailSchema.parse(await res.json());
}

const step = (scope: Page | Locator, key: string) => scope.locator(`[data-step="${key}"]`);

type EvidenceDraft = Draft & { action: NonNullable<Draft["action"]>; pdf: NonNullable<Draft["pdf"]> };

/** The real M2-07 evidence draft, once its proposal waits for the seller; fails fast on "not drafted". */
async function waitForEvidenceDraft(page: Page, disputeId: string, timeoutMs: number): Promise<EvidenceDraft> {
  const until = Date.now() + timeoutMs;
  let last: DisputeDetail | null = null;
  while (Date.now() < until) {
    last = await detail(page, disputeId);
    const d = last.draft;
    if (d?.actionKind === "provide_evidence" && d.action?.state === "proposed" && d.allowed && d.pdf !== null)
      return d as EvidenceDraft;
    if (last.draftOutcome !== null && d === null)
      throw new Error(`M2-07 did not draft: ${JSON.stringify(last.draftOutcome)}`);
    await page.waitForTimeout(5_000);
  }
  throw new Error(
    `no proposed provide_evidence draft within ${String(timeoutMs / MIN)} min: ${JSON.stringify({
      draft: last?.draft ? { kind: last.draft.actionKind, state: last.draft.action?.state } : null,
      draftOutcome: last?.draftOutcome ?? null,
      allowedActions: last?.dispute.allowedActions ?? null,
    })}`,
  );
}

/** The evidence type the reason map gives for PayPal's current dispute (one sandbox GET, read only). */
async function expectedEvidenceType(disputeId: string): Promise<string> {
  const http = createHttpClient({ vendor: "paypal", timeoutMs: VENDOR_TIMEOUTS_MS.paypal });
  const credentials = {
    clientId: process.env["PAYPAL_CLIENT_ID"] ?? "",
    clientSecret: process.env["PAYPAL_CLIENT_SECRET"] ?? "",
  };
  const tokens = createTokenProvider({ http, baseUrl: PAYPAL_SANDBOX_BASE_URL, credentials });
  const fresh = await createPayPalDisputesClient({ http, tokens }).getDispute(disputeId);
  return mapReason(fresh.reason, requestedEvidenceTypes(fresh.evidences)).evidenceType;
}

/** Scope demo check 4: notes ≤ 2000 code points, one compiled PDF < 10 MB, evidence type per the reason map. */
async function checkDraft(draft: EvidenceDraft, disputeId: string): Promise<void> {
  const chars = codePoints(draft.notes);
  expect(chars).toBeGreaterThan(0);
  expect(chars).toBeLessThanOrEqual(2000);
  expect(draft.pdf.bytes).toBeGreaterThan(0);
  expect(draft.pdf.bytes).toBeLessThan(PDF_LIMIT);
  expect(draft.items.filter((i) => i.selected).length).toBeGreaterThan(0);
  expect(draft.action).toMatchObject({ kind: "provide_evidence", createdBy: "agent", state: "proposed" });
  expect(draft.evidenceType).toBe(await expectedEvidenceType(disputeId));
  expect(draft.action.payload).toMatchObject({
    dispute_id: disputeId,
    evidence_type: draft.evidenceType,
    notes: draft.notes,
    draft_id: draft.id,
  });
}

/** Scope demo checks 5–6: the approved hash, the six checks (action link from the re-fetch), 2xx + debug_id. */
function checkFiled(d: DisputeDetail, actionId: string, sha: string): string {
  const action = d.draft?.action;
  expect(action).toMatchObject({ id: actionId, state: "succeeded", payload_sha256: sha });
  const status = Number(action?.execution?.paypalStatus ?? "0");
  expect(status).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
  const debugId = action?.execution?.paypalDebugId ?? "";
  expect(debugId).not.toBe("");
  const mine = d.audit.filter((a) => a.refs.actionId === actionId);
  const checks = mine.filter((a) => a.action === "action.check");
  expect(checks.map((c) => c.detail["check"]).sort()).toEqual([...CHECKS].sort());
  expect(checks.every((c) => c.detail["ok"] === true)).toBe(true);
  const approved = mine.find((a) => a.action === "action.approved");
  expect(approved?.actor).toBe("seller");
  expect(approved?.refs.fingerprint).toBe(sha.slice(0, 8));
  const sent = mine.find((a) => a.action === "action.sent");
  expect(sent?.refs.debugId ?? sent?.detail["debugId"]).toBe(debugId);
  expect(mine.some((a) => a.action === "action.succeeded")).toBe(true);
  return debugId;
}

test("judge: run the dispute scenario on the sandbox to RESOLVED with the hold released", async ({
  page,
}) => {
  test.skip(!live, "live only: E2E_LIVE=1 with sandbox credentials (PAYPAL_SANDBOX)");
  test.setTimeout(60 * MIN);
  const marks: Record<string, string> = { start: new Date().toISOString() };
  const mark = (name: string): void => {
    marks[name] = new Date().toISOString();
    console.log(`judge-dispute ${name} ${marks[name] ?? ""}`);
  };

  await page.goto("/en");
  await page.getByTestId("demo-cta").click();
  await page.waitForURL("**/en/payments");
  const workspaceId = (
    (await (await page.request.get("/api/workspace")).json()) as { workspace: { id: string } }
  ).workspace.id;

  await page.getByRole("button", { name: t.ctaName }).click();
  await page.waitForURL("**/en/scenario/**");
  const id = page.url().split("/").pop() ?? "";
  await expect(page.getByRole("heading", { level: 1, name: t.title })).toBeVisible();
  // the control is shown in the sandbox, disabled until PayPal is ready
  await expect(page.getByRole("button", { name: t.decide })).toBeDisabled();

  await expect(step(page, "chargeback")).toHaveAttribute("data-status", "done", { timeout: 5 * MIN });
  mark("chargeback");
  await expect(step(page, "evidence_step")).toHaveAttribute("data-status", "done", { timeout: 20 * MIN });
  mark("evidence_step");

  const s1 = await scenario(page, id);
  const disputeId = s1.dispute?.disputeId ?? "";
  expect(s1.dispute?.allowedActions).toContain("provide_evidence");

  // the real M2-07 draft and its proposal (pack extracted + scope-checked by M2-03/M2-04)
  const draft = await waitForEvidenceDraft(page, disputeId, 10 * MIN);
  mark("draft_ready");
  await checkDraft(draft, disputeId);
  const sha = draft.action.payload_sha256;
  const fp = sha.slice(0, 8);

  // the seller: dashboard → "Review and approve" → the approval card with the fingerprint → Approve → Send
  await page.goto("/en/payments");
  const row = page.locator(`[data-testid="payment-row"][data-dispute="${disputeId}"]`);
  await row.getByTestId("review-approve").click();
  await page.waitForURL(/\/en\/disputes\/[^/]+#approval$/);
  await expect(page.getByTestId("approval-card")).toBeVisible();
  await expect(page.getByTestId("fingerprint")).toHaveText(fp);
  await page.getByTestId("approve").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(fp);
  await dialog.getByRole("button", { name: en.disputes.confirm.send }).click();
  mark("approved");
  await expect(page.getByTestId("filing-status")).toHaveAttribute("data-state", "succeeded", {
    timeout: 5 * MIN,
  });
  const scenarioBox = page.getByTestId("dispute-scenario");
  await expect(step(scenarioBox, "evidence_filed")).toHaveAttribute("data-status", "done", {
    timeout: 5 * MIN,
  });
  mark("evidence_filed");
  const debugId = checkFiled(await detail(page, disputeId), draft.action.id, sha);
  await expect(page.getByTestId("filing-status")).toContainText(`PayPal debug_id ${debugId}`);

  // the labelled sandbox decision, on the same dispute page
  const decide = scenarioBox.getByRole("button", { name: t.decide });
  await expect(decide).toBeEnabled({ timeout: 20 * MIN });
  mark("decision_offered");
  await decide.click();
  await scenarioBox.getByRole("dialog").getByRole("button", { name: t.confirm }).click();
  await expect(scenarioBox.getByTestId("decision-reason")).toHaveText(t.blocked.already_requested, {
    timeout: MIN,
  });
  mark("decision_requested");

  await expect(page.getByTestId("outcome-text")).toHaveText(en.disputes.outcome.payout, {
    timeout: 25 * MIN,
  });
  mark("resolved");
  await expect(page.locator("body")).not.toContainText(/\bwon\b/i);

  // the scenario page (polled until the run finishes) shows the hold released; the dispute page then too
  await page.goto(`/en/scenario/${id}`);
  await expect(page.getByText(t.outcomePayout)).toBeVisible({ timeout: MIN });
  await expect(page.getByText(t.holdReleased)).toBeVisible({ timeout: 15 * MIN });
  mark("hold_released");
  await page.goto(`/en/disputes/${disputeId}`);
  await expect(page.getByTestId("dispute-outcome")).toContainText(en.disputes.outcome.holdReleased);

  const done = await scenario(page, id);
  expect(done.state).toBe("resolved");
  expect(done.dispute).toMatchObject({
    status: "RESOLVED",
    outcome: { outcome_code: "RESOLVED_WITH_PAYOUT", outcome_reason: "REPRESENTED_BY_PAYPAL" },
  });
  expect(done.capture?.status).toBe("COMPLETED");
  const capture = done.timeline.find((x) => x.key === "capture");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}judge-dispute-live.json`,
    JSON.stringify(
      {
        scenarioId: id,
        workspaceId,
        disputeId,
        paypalIds: capture?.paypalIds,
        draft: {
          id: draft.id,
          actionId: draft.action.id,
          evidenceType: draft.evidenceType,
          notesChars: codePoints(draft.notes),
          pdfBytes: draft.pdf.bytes,
          fingerprint: fp,
        },
        filing: { debugId },
        marks,
        timeline: done.timeline,
      },
      null,
      2,
    ),
  );
});
