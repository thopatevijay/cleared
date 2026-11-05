// M2-10 screens and states for the ui-reviewer (local only, like skeleton.spec.ts's): the scenario page in
// each state the ticket defines, seeded straight into the local database (no PayPal call), captured at
// 375 / 768 / 1440 in light and dark with axe (zero serious/critical). Shots go to .review/M2-10/
// (gitignored). The states' PayPal values are the recorded M0-05 ones.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { WorkspaceIdSchema } from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace, platform, type Db } from "@cleared/db";
import { expect, test, type Page } from "@playwright/test";
import { WCAG_A_AA } from "./support/wcag.ts";

const local = process.env["E2E_BASE_URL"] === undefined && process.env["E2E_LIVE"] !== "1";
const shots = local && process.env["E2E_SCREENSHOTS"] !== "0";
const REVIEW = fileURLToPath(new URL("../../../.review/M2-10/", import.meta.url));

async function axe(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(WCAG_A_AA)
    .analyze();
  mkdirSync(`${REVIEW}axe`, { recursive: true });
  writeFileSync(`${REVIEW}axe/${name}.json`, JSON.stringify(result.violations, null, 2));
  const blocking = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, `axe serious/critical on ${name}`).toEqual([]);
}

async function capture(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      const { sw, cw } = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(sw, `horizontal scroll on ${name}-${String(width)}`).toBeLessThanOrEqual(cw);
      await page.screenshot({ path: `${REVIEW}${name}-${String(width)}-${theme}.png`, fullPage: true });
      await axe(page, `${name}-${String(width)}-${theme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
}

const NOW = Date.now();
// minutes after the capture, on a run that started 70 minutes ago (M0-05 timings)
const at = (minutes: number): Date => new Date(NOW - (70 - minutes) * 60_000);
const iso = (minutes: number): string => at(minutes).toISOString();
const ID = { order: "5O190127TN364715T", capture: "3C679366HH908993F" };

interface Seed {
  readonly state: "capturing" | "polling" | "resolved" | "timed_out";
  readonly dispute?: { status: string; links: string[]; outcome?: boolean };
  readonly capture?: { status: string; reason: string | null };
  readonly evidence?: boolean;
  readonly requested?: boolean;
  /** milestones the poll recorded, in minutes after the capture */
  readonly seen?: {
    hold?: number;
    evidence?: number;
    offered?: number;
    resolved?: number;
    released?: number;
  };
  readonly lastPolled?: number;
}

function seenOf(s: Seed) {
  const m = s.seen ?? {};
  return {
    ...(m.hold === undefined ? {} : { hold: { at: iso(m.hold), status: "PENDING / BUYER_COMPLAINT" } }),
    ...(m.evidence === undefined
      ? {}
      : { evidence_step: { at: iso(m.evidence), status: "WAITING_FOR_SELLER_RESPONSE" } }),
    ...(m.offered === undefined ? {} : { decision_offered: { at: iso(m.offered) } }),
    ...(m.resolved === undefined
      ? {}
      : { resolved: { at: iso(m.resolved), outcomeCode: "RESOLVED_WITH_PAYOUT" } }),
    ...(m.released === undefined ? {} : { released: { at: iso(m.released), status: "COMPLETED" } }),
  };
}

async function seed(db: Db, ws: string, s: Seed): Promise<string> {
  const r = forWorkspace(db, WorkspaceIdSchema.parse(ws));
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const disputeId = `PP-R-UVC-${suffix}`;
  const captureId = `${ID.capture.slice(0, 11)}${suffix}`;
  const withDispute = s.dispute !== undefined;
  const run = await r.scenarioRuns.insert({
    state: s.state,
    orderId: s.state === "capturing" ? null : ID.order,
    captureId: s.state === "capturing" ? null : captureId,
    disputeId: withDispute ? disputeId : null,
    pollStartedAt: withDispute ? at(1) : null,
    lastPolledAt: s.lastPolled === undefined ? null : at(s.lastPolled),
    decisionRequestedAt: s.requested === true ? at(9) : null,
    finishedAt: s.state === "resolved" || s.state === "timed_out" ? at(s.lastPolled ?? 0) : null,
    failure: s.state === "timed_out" ? "poll_limit" : null,
    steps:
      s.state === "capturing"
        ? {}
        : {
            capture: {
              at: at(0).toISOString(),
              orderId: ID.order,
              captureId,
              status: "COMPLETED",
              merchantId: "M",
            },
            seed_pack: { at: at(0.2).toISOString(), packId: "p", evidenceItemIds: [] },
            chargeback: { at: at(0.5).toISOString(), disputeId, adopted: false },
            seen: seenOf(s),
          },
  });
  if (s.capture !== undefined) {
    await r.payments.insert({
      captureId,
      orderId: ID.order,
      amount: "120.00",
      currency: "USD",
      status: s.capture.status,
      statusReason: s.capture.reason,
      source: "poll",
    });
  }
  if (s.dispute !== undefined) {
    await r.disputes.insert({
      disputeId,
      status: s.dispute.status,
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      allowedActions: s.dispute.links,
      paypalUpdatedAt: at(s.lastPolled ?? 1),
      outcome:
        s.dispute.outcome === true
          ? {
              outcome_code: "RESOLVED_WITH_PAYOUT",
              outcome_reason: "REPRESENTED_BY_PAYPAL",
              amount_refunded: null,
            }
          : null,
    });
    await platform(db).resourceOwners.claim({
      resourceType: "dispute",
      resourceId: disputeId,
      workspaceId: ws,
    });
  }
  if (s.evidence === true) {
    const action = await r.proposedActions.insert({
      kind: "provide_evidence",
      payload: { dispute_id: disputeId },
      payloadSha256: "0".repeat(64),
      state: "succeeded",
      risk: "high",
    });
    await r.auditLog.insert({
      actor: "system",
      action: "action.succeeded",
      detail: { actionId: action.id },
      at: at(5),
    });
  }
  return run.id;
}

const STATES: Record<string, Seed> = {
  started: { state: "capturing" },
  "waiting-evidence-step": {
    state: "polling",
    dispute: { status: "UNDER_REVIEW", links: ["provide_supporting_info"] },
    capture: { status: "COMPLETED", reason: null },
    lastPolled: 1.5,
  },
  "decision-not-ready": {
    state: "polling",
    dispute: { status: "UNDER_REVIEW", links: ["provide_supporting_info"] },
    capture: { status: "PENDING", reason: "BUYER_COMPLAINT" },
    evidence: true,
    seen: { hold: 3, evidence: 3.6 },
    lastPolled: 6,
  },
  "decision-ready": {
    state: "polling",
    dispute: { status: "UNDER_REVIEW", links: ["adjudicate", "provide_supporting_info", "require_evidence"] },
    capture: { status: "PENDING", reason: "BUYER_COMPLAINT" },
    evidence: true,
    seen: { hold: 3, evidence: 3.6, offered: 8.5 },
    lastPolled: 8.5,
  },
  resolved: {
    state: "resolved",
    dispute: { status: "RESOLVED", links: [], outcome: true },
    capture: { status: "COMPLETED", reason: null },
    evidence: true,
    requested: true,
    seen: { hold: 3, evidence: 3.6, offered: 8.5, resolved: 15.5, released: 16 },
    lastPolled: 16,
  },
  "timed-out": {
    state: "timed_out",
    dispute: { status: "WAITING_FOR_SELLER_RESPONSE", links: ["accept_claim", "provide_evidence"] },
    capture: { status: "PENDING", reason: "BUYER_COMPLAINT" },
    seen: { hold: 3, evidence: 3.6 },
    lastPolled: 60.5,
  },
};

test("M2-10 scenario screens and states for ui-reviewer (local)", async ({ page }) => {
  test.skip(!shots, "screenshots are local-only");
  test.setTimeout(600_000);
  mkdirSync(REVIEW, { recursive: true });
  const db = createDb(databaseUrl());
  try {
    for (const locale of ["en", "hi"] as const) {
      await page.context().clearCookies();
      await page.goto(`/${locale}`);
      await page.getByTestId("demo-cta").click();
      await page.waitForURL(`**/${locale}/payments`);
      await page.getByTestId("scenario-entry").waitFor();
      await capture(page, `${locale}-dashboard-entry`);
      const ws = ((await (await page.request.get("/api/workspace")).json()) as { workspace: { id: string } })
        .workspace.id;
      for (const [name, s] of Object.entries(STATES)) {
        if (locale === "hi" && name !== "decision-ready" && name !== "resolved") continue;
        // one active run per workspace: finish the previous one first
        await db.$client.query(
          "update scenario_runs set state = 'failed' where workspace_id = $1 and state in ('capturing','seeding','charging_back','polling')",
          [ws],
        );
        const id = await seed(db, ws, s);
        await page.goto(`/${locale}/scenario/${id}`);
        await page.getByTestId("scenario-timeline").waitFor();
        await capture(page, `${locale}-${name}`);
        if (name === "decision-ready" && locale === "en") {
          // keyboard path: focus the sandbox control (focus-visible), open the dialog with Enter
          await page.setViewportSize({ width: 375, height: 800 });
          const control = page.getByTestId("sandbox-decision").getByRole("button").first();
          await page.keyboard.press("Tab");
          await control.focus();
          await control.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${REVIEW}${locale}-focus-sandbox-control-375-light.png` });
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").waitFor();
          await page.screenshot({ path: `${REVIEW}${locale}-confirm-dialog-375-light.png` });
          await axe(page, `${locale}-confirm-dialog-375-light`);
          await page.keyboard.press("Tab");
          await page.screenshot({ path: `${REVIEW}${locale}-confirm-dialog-focus-confirm-375-light.png` });
          await page.keyboard.press("Escape");
        }
      }
      if (locale === "en") {
        await page.route("**/api/scenarios/**", (route) =>
          route.fulfill({
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-correlation-id": "c0ffee00-5ce7-4d1e-9a7a-000000000500",
            },
            body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }),
          }),
        );
        await page.goto(`/${locale}/scenario/00000000-0000-4000-8000-000000000000`);
        await page.getByTestId("error-panel").waitFor();
        await capture(page, `${locale}-error`);
        await page.unroute("**/api/scenarios/**");
        await page.route("**/api/scenarios/**", () => undefined);
        await page.goto(`/${locale}/scenario/00000000-0000-4000-8000-000000000000`);
        await page.getByTestId("loading").waitFor();
        await page.waitForTimeout(3_500);
        await capture(page, `${locale}-loading`);
        await page.waitForTimeout(7_000);
        await page.screenshot({ path: `${REVIEW}${locale}-loading-10s-1440-light.png`, fullPage: true });
        await page.unroute("**/api/scenarios/**");
      }
    }
  } finally {
    await closeDb(db);
  }
});
