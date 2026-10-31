// In-memory ports for the harness unit tests: a scripted AiProvider that records every request, and a
// RunStore that keeps runs, steps and proposals in arrays (the SQL store is tested in packages/db).
import { z } from "zod";
import type { JsonValue } from "../../src/actions/canonical-json.ts";
import type { Sha256, WorkspaceId } from "../../src/ids.ts";
import {
  definePrompt,
  parseAgentConfig,
  type AgentConfig,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
  type RunFinish,
  type RunStart,
  type RunStore,
  type SpendSnapshot,
  type StepRecord,
  type WorkflowDef,
} from "../../src/agent/index.ts";

export const WS = "6f1c1d2e-0b7a-4d43-9a39-6a3c2b1e0f11" as WorkspaceId;

export type Scripted = (
  req: CompletionRequest<z.ZodType>,
) => Promise<CompletionResult<unknown>> | CompletionResult<unknown>;

export function okResult(output: unknown, costUsd = 0.001): CompletionResult<unknown> {
  return {
    ok: true,
    output,
    model: "gpt-6-luna",
    usage: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 300, reasoningTokens: 0 },
    costUsd,
    latencyMs: 5,
  };
}

export function failResult(
  kind: "timeout" | "unavailable" | "rejected" | "refusal" | "incomplete" | "invalid_output",
  costUsd = 0,
): CompletionResult<unknown> {
  return {
    ok: false,
    error: { kind, detail: `${kind} (test)` },
    model: "gpt-6-luna",
    usage: null,
    costUsd,
    latencyMs: 5,
  };
}

export interface FakeProvider extends AiProvider {
  readonly requests: CompletionRequest<z.ZodType>[];
}

/** Answers with `script[i]` for the i-th request (the last entry repeats). */
export function fakeProvider(script: readonly Scripted[]): FakeProvider {
  const requests: CompletionRequest<z.ZodType>[] = [];
  return {
    requests,
    async complete<S extends z.ZodType>(req: CompletionRequest<S>): Promise<CompletionResult<z.infer<S>>> {
      requests.push(req);
      const next = script[Math.min(requests.length - 1, script.length - 1)];
      if (!next) throw new Error("fake provider: empty script");
      return (await next(req)) as CompletionResult<z.infer<S>>;
    },
  };
}

export interface FakeStore extends RunStore {
  readonly runs: (RunStart & { id: string; finish?: RunFinish; costUsd: number })[];
  readonly steps: StepRecord[];
  readonly written: RunFinish["proposals"][number][];
  flag: boolean;
  spendSeed: Partial<SpendSnapshot>;
}

export function fakeStore(): FakeStore {
  const store: FakeStore = {
    runs: [],
    steps: [],
    written: [],
    flag: false,
    spendSeed: {},
    killSwitch: () => Promise.resolve(store.flag),
    spend: () => {
      const spent = store.runs.reduce((a, r) => a + r.costUsd, 0);
      return Promise.resolve({
        workspaceKind: "demo",
        workspaceCapUsd: null,
        workspaceUsd: spent,
        globalTodayUsd: spent,
        ...store.spendSeed,
      });
    },
    findCachedOutput: (_ws: unknown, task: string, inputHash: Sha256) => {
      const hit = store.runs
        .filter((r) => r.task === task && r.inputHash === inputHash && r.finish?.status === "succeeded")
        .at(-1);
      return Promise.resolve(
        hit?.finish?.output != null ? { runId: hit.id, output: hit.finish.output } : null,
      );
    },
    startRun: (run: RunStart) => {
      const id = `run-${String(store.runs.length + 1)}`;
      store.runs.push({ ...run, id, costUsd: 0 });
      return Promise.resolve(id);
    },
    recordStep: (step: StepRecord) => {
      store.steps.push(step);
      const run = store.runs.find((r) => r.id === step.runId);
      if (run) run.costUsd += step.costUsd;
      return Promise.resolve();
    },
    finishRun: (finish: RunFinish) => {
      const run = store.runs.find((r) => r.id === finish.runId);
      if (run) run.finish = finish;
      store.written.push(...finish.proposals);
      return Promise.resolve({
        proposedActionIds: finish.proposals.map((_, i) => `action-${String(i + 1)}`),
      });
    },
  };
  return store;
}

export function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...parseAgentConfig({ AGENT_KILL_SWITCH: "false" }), ...over };
}

export const Answer = z.object({ answer: z.string(), score: z.number().int() });
export type Answer = z.infer<typeof Answer>;

export interface TestInput {
  readonly [key: string]: JsonValue;
  readonly evidence: readonly { readonly id: string; readonly text: string }[];
  readonly calls: number;
}

/** A workflow that makes `input.calls` calls over text evidence and returns the last answer. */
export const testWorkflow: WorkflowDef<TestInput, Answer> = {
  prompt: definePrompt("harness_test@v1", "You answer test questions about the evidence."),
  schemaVersion: "1",
  model: "small",
  outputSchema: Answer,
  async run(ctx, input) {
    let last: Answer = { answer: "", score: 0 };
    for (let i = 0; i < input.calls; i++) {
      last = await ctx.call({
        name: `step${String(i + 1)}`,
        task: "Answer the question using the evidence.",
        evidence: input.evidence.map((e) => ({ kind: "text" as const, id: e.id, label: e.id, text: e.text })),
        schemaName: "answer",
        schema: Answer,
        maxOutputTokens: 1_000,
      });
    }
    return last;
  },
};

export const ANSWER = { answer: "the logo was delivered", score: 3 };
