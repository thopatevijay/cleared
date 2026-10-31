// M2-02 end to end: runWorkflow (core) + the OpenAI provider (adapters) replaying the M0-07 / M2-02
// recordings through msw + the SQL RunStore (db) on the compose Postgres. msw proves which requests left
// the process: `unused()` lists fixtures never requested, `unmatched()` lists requests with no fixture.
import { randomUUID } from "node:crypto";
import {
  createHttpClient,
  createOpenAiCompletionProvider,
  ExtractResult,
  type ExtractResult as Extract,
} from "@cleared/adapters";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import {
  definePrompt,
  parseAgentConfig,
  runWorkflow,
  WorkspaceIdSchema,
  type AiProvider,
  type WorkflowDef,
  type WorkspaceId,
} from "@cleared/core";
import { closeDb, createDb, createRunStore, forWorkspace, platform } from "@cleared/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { dbAvailable, url } from "./helpers.ts";

const Pack = z.object({ items: z.array(ExtractResult) });
type Pack = z.infer<typeof Pack>;
interface PackInput {
  readonly [key: string]: string | readonly { readonly id: string; readonly text: string }[];
  readonly nonce: string;
  readonly items: readonly { readonly id: string; readonly text: string }[];
}

/** A test workflow: one `extract` call per evidence item (the M0-07 step), then a proposal. */
const extractPack: WorkflowDef<PackInput, Pack> = {
  prompt: definePrompt("harness_e2e@v1", "You extract structured facts from ONE evidence item."),
  schemaVersion: "1",
  model: "small",
  outputSchema: Pack,
  async run(ctx, input) {
    const items: Extract[] = [];
    for (const item of input.items) {
      items.push(
        await ctx.call({
          name: `extract:${item.id}`,
          task: "Extract the facts from this evidence item.",
          evidence: [{ kind: "text", id: item.id, label: item.id, text: item.text }],
          schemaName: "extract_result",
          schema: ExtractResult,
          maxOutputTokens: 1_500,
          reasoningEffort: "none",
        }),
      );
    }
    await ctx.proposeAction("provide_evidence", {
      dispute_id: "PP-R-UVC-10195076",
      notes: "See E1, E2.",
      evidence_item_ids: [],
    });
    return { items };
  },
};

const input = (n: number): PackInput => ({
  nonce: randomUUID(),
  items: [
    { id: "E1", text: "Scope brief: primary logo in SVG and PNG." },
    { id: "E2", text: "Chat: the buyer approved the final files." },
  ].slice(0, n),
});

describe.skipIf(!dbAvailable)("agent harness end to end (msw replay + compose Postgres)", () => {
  const db = createDb(url);
  const store = createRunStore(db);
  let ws: WorkspaceId;
  let replay: Replay | null = null;
  const provider = (): AiProvider =>
    createOpenAiCompletionProvider({
      apiKey: "replay",
      http: createHttpClient({ vendor: "openai", timeoutMs: 5_000 }),
    });
  const deps = (p: AiProvider, workspaceId = ws, over = {}) => ({
    provider: p,
    store,
    // a shared test database accumulates spend across runs: only the daily-cap test sets a real cap
    config: { ...parseAgentConfig({}), dailyCapUsd: 1_000_000, ...over },
    workspaceId,
    correlationId: randomUUID(),
  });
  const newWorkspace = async (llmBudgetUsd?: string) => {
    const row = await platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
      ...(llmBudgetUsd ? { llmBudgetUsd } : {}),
    });
    return WorkspaceIdSchema.parse(row.id);
  };
  const serve = (...names: string[]) => {
    replay = startReplay(names);
    return replay;
  };

  beforeAll(async () => {
    ws = await newWorkspace();
  });
  afterEach(() => {
    replay?.close();
    replay = null;
  });
  afterAll(() => closeDb(db));

  it("replaying fixtures/openai, a test workflow returns schema-valid output and writes 1 agent_runs + N agent_steps with tokens and cost", async () => {
    const r = serve("openai/extract/r1-E1", "openai/extract/r1-E2");
    const out = await runWorkflow(extractPack, input(2), deps(provider()));
    expect(r.unused()).toEqual([]);
    expect(r.unmatched()).toEqual([]);
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    expect(Pack.safeParse(out.output).success).toBe(true);
    const repos = forWorkspace(db, ws);
    const run = await repos.agentRuns.get(out.runId);
    expect(run).toMatchObject({
      status: "succeeded",
      promptVersion: "harness_e2e@v1",
      model: "gpt-6-luna",
      tokensIn: 494 + 665,
      tokensOut: 356 + 384,
    });
    expect(Number(run?.costUsd)).toBeCloseTo(out.costUsd, 8);
    expect(Number(run?.costUsd)).toBeGreaterThan(0);
    const steps = (await repos.agentSteps.list({ limit: 500 }))
      .filter((s) => s.runId === out.runId)
      .sort((a, b) => a.stepIndex - b.stepIndex);
    expect(steps.map((s) => [s.kind, s.task, s.status, s.tokensIn, s.tokensOut])).toEqual([
      ["call", "extract:E1", "ok", 494, 356],
      ["call", "extract:E2", "ok", 665, 384],
      ["guardrail", "proposal", "accepted", 0, 0],
    ]);
    expect(steps.every((s) => s.correlationId === run?.correlationId)).toBe(true);
    const actions = (await repos.proposedActions.list()).filter((a) => a.createdByRunId === out.runId);
    expect(actions).toHaveLength(1);
  });

  it("with spend seeded at the workspace cap: budget_exceeded and msw receives zero requests", async () => {
    const capped = await newWorkspace();
    await forWorkspace(db, capped).agentRuns.insert({
      task: "seed",
      inputHash: "0".repeat(64),
      model: "gpt-6-luna",
      status: "succeeded",
      costUsd: "0.10",
    });
    const r = serve("openai/extract/r1-E1");
    const out = await runWorkflow(extractPack, input(1), deps(provider(), capped));
    expect(out.status).toBe("budget_exceeded");
    expect(r.unused()).toEqual(["openai/extract/r1-E1"]);
    expect(r.unmatched()).toEqual([]);
  });

  it("with global spend at the daily cap: budget_exceeded and msw receives zero requests", async () => {
    const today = await store.spend(
      ws,
      new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())),
    );
    const seller = WorkspaceIdSchema.parse(
      (
        await platform(db).workspaces.create({
          kind: "seller",
          locale: "en",
          timezone: "UTC",
          baseCurrency: "USD",
        })
      ).id,
    );
    await forWorkspace(db, seller).agentRuns.insert({
      task: "seed",
      inputHash: "0".repeat(64),
      model: "gpt-6-luna",
      status: "succeeded",
      costUsd: "0.25",
    });
    const r = serve("openai/extract/r1-E1");
    const out = await runWorkflow(
      extractPack,
      input(1),
      // a cent under the seeded $0.25: `x + 0.25` in floating point can land above the exact decimal sum the
      // store reads back (seen in CI once M2-04's replays added odd-cent costs to the shared database)
      deps(provider(), seller, { dailyCapUsd: today.globalTodayUsd + 0.24 }),
    );
    expect(out).toMatchObject({
      status: "budget_exceeded",
      reason: expect.stringContaining("daily cap") as string,
    });
    expect(r.unused()).toEqual(["openai/extract/r1-E1"]);
    expect(r.unmatched()).toEqual([]);
  });

  it("two identical inputs: the second is a cache_hit at cost 0 with no provider request", async () => {
    const same = input(1);
    const r = serve("openai/extract/r4-E1");
    const first = await runWorkflow(extractPack, same, deps(provider()));
    const second = await runWorkflow(extractPack, same, deps(provider()));
    expect(first.status).toBe("succeeded");
    expect(second).toMatchObject({ status: "cache_hit", costUsd: 0, calls: 0 });
    expect(r.unused()).toEqual([]);
    expect(r.unmatched()).toEqual([]); // the second run sent nothing
    if (second.runId === null) throw new Error("no run id");
    const row = await forWorkspace(db, ws).agentRuns.get(second.runId);
    expect(row).toMatchObject({
      status: "cache_hit",
      costUsd: "0",
      output: first.status === "succeeded" ? first.output : null,
    });
  });

  it("malformed model output (fixture) → one repair attempt → failed_output; no output and no proposal written", async () => {
    const r = serve("openai/m2-02/malformed-output-derived", "openai/m2-02/malformed-output-derived");
    const out = await runWorkflow(extractPack, input(1), deps(provider()));
    expect(out.status).toBe("failed_output");
    expect(r.unused()).toEqual([]);
    expect(r.unmatched()).toEqual([]);
    if (out.runId === null) throw new Error("no run id");
    const repos = forWorkspace(db, ws);
    const run = await repos.agentRuns.get(out.runId);
    expect(run).toMatchObject({ status: "failed_output", output: null });
    expect(Number(run?.costUsd)).toBeGreaterThan(0); // both billed calls are charged
    const steps = (await repos.agentSteps.list({ limit: 500 })).filter((s) => s.runId === out.runId);
    expect(steps.map((s) => s.task).sort()).toEqual(["extract:E1", "extract:E1:repair"]);
    expect((await repos.proposedActions.list()).filter((a) => a.createdByRunId === out.runId)).toEqual([]);
  });

  it("a provider timeout → degraded (typed result), and the run row says so", async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_res, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    const p = createOpenAiCompletionProvider({
      apiKey: "replay",
      http: createHttpClient({ vendor: "openai", timeoutMs: 5, fetch: hang }),
    });
    const out = await runWorkflow(extractPack, input(1), deps(p));
    expect(out).toMatchObject({ status: "degraded", reason: expect.stringContaining("timeout") as string });
    if (out.runId === null) throw new Error("no run id");
    expect(await forWorkspace(db, ws).agentRuns.get(out.runId)).toMatchObject({
      status: "degraded",
      output: null,
    });
  });

  it("kill switch: the DB flag refuses the run before any request", async () => {
    await platform(db).flags.setAgentKillSwitch(true);
    try {
      const r = serve("openai/extract/r1-E1");
      const out = await runWorkflow(extractPack, input(1), deps(provider()));
      expect(out).toMatchObject({ status: "kill_switch", runId: null });
      expect(r.unused()).toEqual(["openai/extract/r1-E1"]);
    } finally {
      await platform(db).flags.setAgentKillSwitch(false);
    }
  });
});
