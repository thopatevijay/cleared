// M2-10: the judge scenario API. Start (sandbox, demo workspace, one active run, global LLM cap), the run
// view, and the "Simulate PayPal's decision (sandbox only)" route: absent outside the sandbox, refused
// without the adjudicate link or our filed evidence (AC3, API side), and another workspace's run is a 404.
import { randomUUID } from "node:crypto";
import { WorkspaceIdSchema } from "@cleared/core";
import { createPublisher, createQueue, forWorkspace, platform, type Publisher } from "@cleared/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postDemo } from "../../../src/server/handlers/demo.ts";
import {
  getScenario,
  getScenarios,
  postDecide,
  postScenario,
} from "../../../src/server/handlers/scenarios.ts";
import { getWorkspace } from "../../../src/server/handlers/session-routes.ts";
import { cookieFrom, freshIp, req, testDb, testDeps } from "../../../test/support/db.ts";
import { dbAvailable } from "../../../test/support/db-available.ts";

let pub: Promise<Publisher> | undefined;
const created: string[] = [];
const publisher = (): Promise<Publisher> => {
  pub ??= createQueue(testDb(), { background: false, max: 2 }).then((b) => createPublisher(testDb(), b));
  return pub;
};

async function demo(): Promise<{ cookie: string; ws: string }> {
  const deps = testDeps();
  const cookie = cookieFrom(await postDemo(req("/api/demo", { ip: freshIp() }), deps));
  const res = await getWorkspace(req("/api/workspace", { method: "GET", cookie }), deps);
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  created.push(ws);
  return { cookie, ws };
}

const repos = (ws: string) => forWorkspace(testDb(), WorkspaceIdSchema.parse(ws));

type Body = {
  scenario?: Record<string, unknown> & { decision?: Record<string, unknown> };
  available?: boolean;
  reason?: string | null;
  latest?: { id: string } | null;
  error?: { code: string; details: Record<string, unknown> | null };
};
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

const start = async (cookie: string) =>
  read(await postScenario(req("/api/scenarios", { cookie, body: {} }), testDeps(), publisher));
const decide = async (cookie: string, id: string) =>
  read(await postDecide(req(`/api/scenarios/${id}/decide`, { cookie, body: {} }), testDeps(), publisher, id));
const view = async (cookie: string, id: string) =>
  read(await getScenario(req(`/api/scenarios/${id}`, { method: "GET", cookie }), testDeps(), id));

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await testDb().$client.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/** A run that reached polling, with its dispute mirrored (as the worker's steps and sync leave it). */
async function polling(ws: string, allowed: string[], owned = true) {
  const disputeId = `PP-R-TST-${randomUUID().slice(0, 8).toUpperCase()}`;
  const run = await repos(ws).scenarioRuns.insert({
    state: "polling",
    disputeId,
    pollStartedAt: new Date(),
    steps: { chargeback: { at: new Date().toISOString(), disputeId, adopted: false } },
  });
  await repos(ws).disputes.insert({ disputeId, status: "UNDER_REVIEW", allowedActions: allowed });
  if (owned) {
    await platform(testDb()).resourceOwners.claim({
      resourceType: "dispute",
      resourceId: disputeId,
      workspaceId: ws,
    });
  }
  return { run, disputeId };
}

async function fileEvidence(ws: string, disputeId: string): Promise<void> {
  const action = await repos(ws).proposedActions.insert({
    kind: "provide_evidence",
    payload: { dispute_id: disputeId },
    payloadSha256: "0".repeat(64),
    state: "succeeded",
    risk: "high",
  });
  await repos(ws).auditLog.insert({
    actor: "system",
    action: "action.succeeded",
    detail: { actionId: action.id },
  });
}

describe.skipIf(!dbAvailable)("judge scenario API (integration)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYPAL_ENV", "sandbox");
    vi.stubEnv("LLM_DAILY_CAP_USD", "1000000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    const db = testDb();
    await db.$client.query("delete from pgboss.job where data->>'workspaceId' = any($1)", [created]);
    await db.$client.query(
      "update outbox set published_at = now() where published_at is null and payload->>'workspaceId' = any($1)",
      [created],
    );
  });

  it("POST /api/scenarios starts one run (capture job + audit in one transaction); a second is 409", async () => {
    const a = await demo();
    const index = await read(
      await getScenarios(req("/api/scenarios", { method: "GET", cookie: a.cookie }), testDeps()),
    );
    expect(index.body).toEqual({ available: true, reason: null, latest: null });
    const first = await start(a.cookie);
    expect(first.status).toBe(201);
    const id = String(first.body.scenario?.["id"]);
    expect(first.body.scenario?.["state"]).toBe("capturing");
    expect(
      await count(
        "select count(*) as n from pgboss.job where name = 'scenario.capture' and data->'data'->>'scenarioId' = $1",
        [id],
      ),
    ).toBe(1);
    const audit = await repos(a.ws).auditLog.list();
    expect(audit.find((r) => r.action === "scenario.started")).toMatchObject({ actor: "seller" });
    const second = await start(a.cookie);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "scenario_active", details: { scenarioId: id } });
    const v = await view(a.cookie, id);
    expect(v.status).toBe(200);
    expect(v.body.scenario).toMatchObject({ state: "capturing", outcome: null, holdReleased: false });
    expect(v.body.scenario?.decision).toMatchObject({ shown: true, enabled: false, reason: "no_dispute" });
  });

  it("outside the sandbox the scenario is unavailable and the decision route is absent (404)", async () => {
    const a = await demo();
    const { run } = await polling(a.ws, ["adjudicate"]);
    vi.stubEnv("PAYPAL_ENV", "live");
    const index = await read(
      await getScenarios(req("/api/scenarios", { method: "GET", cookie: a.cookie }), testDeps()),
    );
    expect(index.body).toMatchObject({ available: false, reason: "not_sandbox" });
    expect((await start(a.cookie)).status).toBe(404);
    const d = await decide(a.cookie, run.id);
    expect(d.status).toBe(404);
    const v = await view(a.cookie, run.id);
    expect(v.body.scenario?.decision).toMatchObject({ shown: false, enabled: false, reason: "not_sandbox" });
    expect(
      await count(
        "select count(*) as n from pgboss.job where name = 'scenario.decide' and data->'data'->>'scenarioId' = $1",
        [run.id],
      ),
    ).toBe(0);
  });

  it("no scenario starts while the global LLM cap is reached (and the dashboard says why)", async () => {
    const a = await demo();
    vi.stubEnv("LLM_DAILY_CAP_USD", "0");
    const index = await read(
      await getScenarios(req("/api/scenarios", { method: "GET", cookie: a.cookie }), testDeps()),
    );
    expect(index.body).toMatchObject({ available: false, reason: "llm_cap" });
    const r = await start(a.cookie);
    expect(r.status).toBe(429);
    expect(r.body.error?.code).toBe("llm_cap_reached");
  });

  it("the decision is refused without our filed evidence or the adjudicate link, then queued once", async () => {
    const a = await demo();
    const noLink = await polling(a.ws, ["provide_evidence", "accept_claim"]);
    await fileEvidence(a.ws, noLink.disputeId);
    const refusedLink = await decide(a.cookie, noLink.run.id);
    expect(refusedLink.status).toBe(409);
    expect(refusedLink.body.error).toMatchObject({
      code: "decision_not_ready",
      details: { reason: "no_adjudicate_link" },
    });
    await repos(a.ws).scenarioRuns.update(noLink.run.id, { state: "resolved" });

    const b = await demo();
    const ready = await polling(b.ws, ["adjudicate", "provide_supporting_info", "require_evidence"]);
    const refusedEvidence = await decide(b.cookie, ready.run.id);
    expect(refusedEvidence.body.error?.details).toEqual({ reason: "evidence_not_filed" });
    await fileEvidence(b.ws, ready.disputeId);
    // another workspace can neither see nor decide this run
    expect((await decide(a.cookie, ready.run.id)).status).toBe(404);
    expect((await view(a.cookie, ready.run.id)).status).toBe(404);

    const ok = await decide(b.cookie, ready.run.id);
    expect(ok.status).toBe(202);
    expect(ok.body.scenario?.decision).toMatchObject({ enabled: false, reason: "already_requested" });
    expect(
      await count(
        "select count(*) as n from pgboss.job where name = 'scenario.decide' and data->'data'->>'scenarioId' = $1",
        [ready.run.id],
      ),
    ).toBe(1);
    const audit = await repos(b.ws).auditLog.list();
    expect(audit.find((r) => r.action === "scenario.decision_requested")).toMatchObject({
      actor: "seller",
      detail: { sandbox_decision: true, disputeId: ready.disputeId },
    });
    const again = await decide(b.cookie, ready.run.id);
    expect(again.status).toBe(409);
    expect(again.body.error?.details).toEqual({ reason: "already_requested" });
  });

  it("a dispute this workspace doesn't own never enables the decision", async () => {
    const a = await demo();
    const unowned = await polling(a.ws, ["adjudicate"], false);
    await fileEvidence(a.ws, unowned.disputeId);
    const d = await decide(a.cookie, unowned.run.id);
    expect(d.body.error?.details).toEqual({ reason: "not_owned" });
  });

  it("the App Router modules export the handlers", async () => {
    const index = await import("./route.ts");
    const one = await import("./[id]/route.ts");
    const dec = await import("./[id]/decide/route.ts");
    expect(typeof index.GET).toBe("function");
    expect(typeof index.POST).toBe("function");
    expect(typeof one.GET).toBe("function");
    expect(typeof dec.POST).toBe("function");
  });
});
