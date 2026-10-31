// M2-02: the SQL RunStore and the proposal insert, against the compose Postgres. The harness logic is
// unit-tested in packages/core; here: traces land in the tables, spend sums, the cache lookup, the DB
// kill-switch flag, and proposals + outbox commit (or roll back) together.
import {
  canonicalHash,
  checkProposal,
  definePrompt,
  parseAgentConfig,
  runWorkflow,
  WorkspaceIdSchema,
  type AiProvider,
  type CheckedProposal,
  type CompletionRequest,
  type CompletionResult,
  type WorkflowDef,
  type WorkspaceId,
} from "@cleared/core";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentRuns, agentSteps, auditLog, outbox, proposedActions } from "../schema/index.ts";
import { closeDb, createDb } from "../src/client.ts";
import { createRunStore } from "../src/repositories/agent-runs.ts";
import { insertProposedActions } from "../src/repositories/proposed-actions.ts";
import { platform } from "../src/repos/platform/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

const Out = z.object({ answer: z.string() });
type Out = z.infer<typeof Out>;
const PAYLOAD = { dispute_id: "PP-R-UVC-10195076", notes: "Delivered on 2 Oct.", evidence_item_ids: [] };

function provider(costUsd = 0.0004): AiProvider & { calls: number } {
  const p = {
    calls: 0,
    complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
      p.calls += 1;
      return Promise.resolve({
        ok: true,
        output: { answer: "ok" } as z.infer<S>,
        model: req.model,
        usage: { inputTokens: 612, cachedInputTokens: 0, outputTokens: 343, reasoningTokens: 0 },
        costUsd,
        latencyMs: 3,
      });
    },
  };
  return p;
}

const workflow = (propose: boolean): WorkflowDef<{ q: string }, Out> => ({
  prompt: definePrompt("db_store_test@v1", "Answer."),
  schemaVersion: "1",
  model: "small",
  outputSchema: Out,
  async run(ctx, input) {
    const out = await ctx.call({
      name: "ask",
      task: "Answer the question.",
      evidence: [{ kind: "text", id: "E1", label: "q", text: input.q }],
      schemaName: "out",
      schema: Out,
      maxOutputTokens: 500,
    });
    if (propose) await ctx.proposeAction("provide_evidence", PAYLOAD);
    return out;
  },
});

describe.skipIf(!dbAvailable)("agent RunStore (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  const store = createRunStore(db);
  let ws: WorkspaceId;
  const deps = (p: AiProvider, over = {}) => ({
    provider: p,
    store,
    // a shared test database accumulates spend across runs: only the daily-cap test sets a real cap
    config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000, ...over },
    workspaceId: ws,
    correlationId: "7e0f4c1a-6a1b-4f7e-9a51-1f2d3c4b5a69",
  });

  beforeAll(async () => {
    const row = await platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
    });
    ws = WorkspaceIdSchema.parse(row.id);
  });
  afterEach(() => platform(db).flags.setAgentKillSwitch(false));
  afterAll(() => closeDb(db));

  it("a run writes agent_runs + agent_steps with tokens, cost, prompt version and correlation id, plus an audit entry", async () => {
    const out = await runWorkflow(workflow(false), { q: `trace ${String(Date.now())}` }, deps(provider()));
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, out.runId));
    expect(run).toMatchObject({
      workspaceId: ws,
      task: "db_store_test",
      promptVersion: "db_store_test@v1",
      model: "gpt-6-luna",
      status: "succeeded",
      tokensIn: 612,
      tokensOut: 343,
      costUsd: "0.00040000",
      output: { answer: "ok" },
      correlationId: "7e0f4c1a-6a1b-4f7e-9a51-1f2d3c4b5a69",
    });
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, out.runId));
    expect(steps.map((s) => [s.kind, s.task, s.status, s.tokensIn, s.costUsd])).toEqual([
      ["call", "ask", "ok", 612, "0.00040000"],
    ]);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws), eq(auditLog.action, "agent_run.succeeded")));
    expect(
      audits.some((a) => (a.detail as { runId?: string }).runId === out.runId && a.actor === "agent"),
    ).toBe(true);
  });

  it("the second identical input is a cache_hit at cost 0 with no provider call", async () => {
    const p = provider();
    const input = { q: `cache ${String(Date.now())}` };
    const first = await runWorkflow(workflow(false), input, deps(p));
    const second = await runWorkflow(workflow(false), input, deps(p));
    expect(first.status).toBe("succeeded");
    expect(second).toMatchObject({ status: "cache_hit", costUsd: 0, output: { answer: "ok" } });
    expect(p.calls).toBe(1);
    if (second.runId === null) throw new Error("no run id");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, second.runId));
    expect(row).toMatchObject({ status: "cache_hit", costUsd: "0" });
  });

  it("spend: the workspace sum and the UTC-day global sum come from agent_runs", async () => {
    const day = new Date(Date.UTC(2000, 0, 1));
    const before = await store.spend(ws, day);
    await runWorkflow(workflow(false), { q: `spend ${String(Date.now())}` }, deps(provider(0.0125)));
    const after = await store.spend(ws, day);
    expect(after.workspaceKind).toBe("demo");
    expect(after.workspaceCapUsd).toBeNull();
    expect(after.workspaceUsd - before.workspaceUsd).toBeCloseTo(0.0125, 8);
    expect(after.globalTodayUsd - before.globalTodayUsd).toBeCloseTo(0.0125, 8);
    const future = await store.spend(ws, new Date(Date.now() + 86_400_000));
    expect(future.globalTodayUsd).toBe(0);
  });

  it("budget: with spend at the workspace's own cap the run is budget_exceeded and the provider is not called", async () => {
    const row = await platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
      llmBudgetUsd: "0.0004",
    });
    const p = provider();
    const local = { ...deps(p), workspaceId: WorkspaceIdSchema.parse(row.id) };
    expect((await runWorkflow(workflow(false), { q: "a" }, local)).status).toBe("succeeded");
    expect((await runWorkflow(workflow(false), { q: "b" }, local)).status).toBe("budget_exceeded");
    expect(p.calls).toBe(1);
  });

  it("kill switch: the DB flag refuses runs (no provider call)", async () => {
    await platform(db).flags.setAgentKillSwitch(true);
    expect(await store.killSwitch()).toBe(true);
    const p = provider();
    const out = await runWorkflow(workflow(false), { q: "killed" }, deps(p));
    expect(out).toMatchObject({ status: "kill_switch", runId: null });
    expect(p.calls).toBe(0);
    await platform(db).flags.setAgentKillSwitch(false);
    expect(await store.killSwitch()).toBe(false);
  });

  it("a proposal from a run is stored with payload_sha256 = canonicalHash(payload), created_by_run_id and an outbox row", async () => {
    const out = await runWorkflow(workflow(true), { q: `propose ${String(Date.now())}` }, deps(provider()));
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    expect(out.proposedActionIds).toHaveLength(1);
    const [action] = await db
      .select()
      .from(proposedActions)
      .where(eq(proposedActions.createdByRunId, out.runId));
    expect(action).toMatchObject({
      kind: "provide_evidence",
      state: "proposed",
      risk: "high",
      workspaceId: ws,
    });
    expect(action?.payloadSha256).toBe(canonicalHash(action?.payload as typeof PAYLOAD));
    expect(action?.payloadSha256).toBe(canonicalHash(PAYLOAD));
    const events = await db.select().from(outbox).where(eq(outbox.topic, "action.proposed"));
    const mine = events.find(
      (e) => (e.payload as { data: { actionId: string } }).data.actionId === action?.id,
    );
    expect(mine?.payload).toMatchObject({
      type: "action.proposed",
      workspaceId: ws,
      data: { kind: "provide_evidence", payloadSha256: canonicalHash(PAYLOAD), runId: out.runId },
    });
  });

  it("proposal + outbox are one transaction: a failure after them rolls both back", async () => {
    const out = await runWorkflow(workflow(false), { q: `tx ${String(Date.now())}` }, deps(provider()));
    if (out.runId === null) throw new Error("no run id");
    const check = checkProposal("provide_evidence", PAYLOAD);
    if (!check.ok) throw new Error("payload refused");
    const proposal: CheckedProposal = check.proposal;
    const err = await withTransaction(db, async (tx) => {
      await insertProposedActions(
        db,
        [{ workspaceId: ws, runId: out.runId ?? "", proposal, at: new Date() }],
        tx,
      );
      throw new Error("rollback");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const rows = await db.select().from(proposedActions).where(eq(proposedActions.createdByRunId, out.runId));
    expect(rows).toHaveLength(0);
    const events = await db.select().from(outbox).where(eq(outbox.topic, "action.proposed"));
    expect(
      events.filter((e) => (e.payload as { data: { runId: string } }).data.runId === out.runId),
    ).toHaveLength(0);
  });

  it("refuses to store a proposal whose hash does not match its payload", async () => {
    const out = await runWorkflow(workflow(false), { q: `bad ${String(Date.now())}` }, deps(provider()));
    const check = checkProposal("provide_evidence", PAYLOAD);
    if (!check.ok || out.runId === null) throw new Error("setup");
    const forged = { ...check.proposal, payloadSha256: canonicalHash({ other: 1 }) };
    await expect(
      insertProposedActions(db, [{ workspaceId: ws, runId: out.runId, proposal: forged, at: new Date() }]),
    ).rejects.toThrow(/does not match/);
  });

  it("kill switch: the DB flag set mid-run refuses proposeAction; nothing is written", async () => {
    const wf: WorkflowDef<{ q: string }, Out> = {
      ...workflow(false),
      async run(ctx, input) {
        const out = await workflow(false).run(ctx, input);
        await platform(db).flags.setAgentKillSwitch(true);
        const check = await ctx.proposeAction("provide_evidence", PAYLOAD);
        expect(check).toMatchObject({ ok: false, reason: "kill_switch_on" });
        return out;
      },
    };
    const out = await runWorkflow(wf, { q: `kill-propose ${String(Date.now())}` }, deps(provider()));
    if (out.runId === null) throw new Error("no run id");
    const rows = await db.select().from(proposedActions).where(eq(proposedActions.createdByRunId, out.runId));
    expect(rows).toHaveLength(0);
    const [step] = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, out.runId), eq(agentSteps.kind, "guardrail")));
    expect(step).toMatchObject({ task: "proposal", status: "kill_switch_on" });
  });
});
