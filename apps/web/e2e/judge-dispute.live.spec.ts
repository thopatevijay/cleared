// M2-10 live judge path (M2-GATE runs it from a clean stack): a demo seller runs the dispute scenario
// against the REAL PayPal sandbox and watches it reach dispute RESOLVED (RESOLVED_WITH_PAYOUT) with the
// capture COMPLETED. Every PayPal step is a real sandbox call: card order + capture with custom_id =
// workspace, process-chargeback, dispute and capture syncs, the evidence filing and the labelled
// "Simulate PayPal's decision (sandbox only)" (adjudicate). M0-05 measured ≈ 21.5 min end to end.
//
// Live only: E2E_LIVE=1 with the main checkout's .env loaded by path (WORKFLOW.md "Live lines"), so the
// local web and worker start WITHOUT the msw stub (playwright.config.ts). Skipped otherwise.
// The evidence draft is a test stand-in for M2-07 (support/stand-in-draft.ts); the approval goes through
// the real M2-08 API. When M2-07/M2-09 land, swap the stand-in for the dispute page's Approve button.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScenarioViewSchema, type ScenarioView } from "@cleared/core";
import { expect, test, type Page } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import { standInEvidenceProposal } from "./support/stand-in-draft.ts";

const live = process.env["E2E_LIVE"] === "1";
const OUT = fileURLToPath(new URL("../test-results/", import.meta.url));
const MIN = 60_000;
const t = en.scenario;

async function scenario(page: Page, id: string): Promise<ScenarioView> {
  const res = await page.request.get(`/api/scenarios/${id}`);
  expect(res.status()).toBe(200);
  return ScenarioViewSchema.parse(((await res.json()) as { scenario: unknown }).scenario);
}

const step = (page: Page, key: string) => page.locator(`[data-step="${key}"]`);

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
  const decide = page.getByRole("button", { name: t.decide });
  await expect(decide).toBeDisabled();

  await expect(step(page, "chargeback")).toHaveAttribute("data-status", "done", { timeout: 5 * MIN });
  mark("chargeback");
  await expect(step(page, "evidence_step")).toHaveAttribute("data-status", "done", { timeout: 20 * MIN });
  mark("evidence_step");

  const s1 = await scenario(page, id);
  const disputeId = s1.dispute?.disputeId ?? "";
  expect(s1.dispute?.allowedActions).toContain("provide_evidence");
  const proposal = await standInEvidenceProposal(workspaceId, disputeId);
  const approve = await page.request.post(`/api/actions/${proposal.actionId}/approve`, {
    data: { payload_sha256: proposal.payloadSha256 },
    headers: { origin: new URL(page.url()).origin, "idempotency-key": `judge-${proposal.actionId}` },
  });
  expect(approve.status()).toBe(200);
  await expect(step(page, "evidence_filed")).toHaveAttribute("data-status", "done", { timeout: 5 * MIN });
  mark("evidence_filed");

  await expect(decide).toBeEnabled({ timeout: 20 * MIN });
  mark("decision_offered");
  await decide.click();
  await page.getByRole("dialog").getByRole("button", { name: t.confirm }).click();
  await expect(page.getByTestId("decision-reason")).toHaveText(t.blocked.already_requested, { timeout: MIN });
  mark("decision_requested");

  await expect(page.getByText(t.outcomePayout)).toBeVisible({ timeout: 25 * MIN });
  mark("resolved");
  await expect(page.getByText(t.holdReleased)).toBeVisible({ timeout: 15 * MIN });
  mark("hold_released");

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
        marks,
        timeline: done.timeline,
      },
      null,
      2,
    ),
  );
});
