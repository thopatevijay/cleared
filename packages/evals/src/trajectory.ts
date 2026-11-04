// Trajectory checks (M4-02) over the run records every eval run leaves in its store (the agent_runs /
// agent_steps shape): the steps a workflow took, in order, and the caps it stayed inside. The scripted
// trajectory cases (order, retry, timeout, caps, draft_dispute) are in test/trajectory.test.ts.
import { DEFAULT_RUN_LIMITS, type AgentConfig } from "@cleared/core";
import type { EvalStore } from "./store.ts";

/** The step names of one run, in the order the harness recorded them. */
export function stepNames(store: EvalStore, runId: string | null): string[] {
  return store.steps
    .filter((s) => s.runId === runId)
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((s) => s.name);
}

export interface TrajectorySummary {
  readonly runs: number;
  readonly max_calls_per_run: number;
  readonly max_output_tokens_step: number;
  /** wall time per run as the harness measured it (replay: near zero; live: the real run) */
  readonly max_run_latency_ms: number;
  readonly pass: boolean;
}

/** Every run within ≤ 6 model calls, the per-step output cap and the wall clock. */
export function trajectorySummary(store: EvalStore, config: AgentConfig): TrajectorySummary {
  const calls = new Map<string, number>();
  let maxOut = 0;
  for (const s of store.steps) {
    if (s.kind !== "call") continue;
    calls.set(s.runId, (calls.get(s.runId) ?? 0) + 1);
    maxOut = Math.max(maxOut, s.tokensOut);
  }
  const maxCalls = Math.max(0, ...calls.values());
  const maxMs = Math.max(0, ...store.runs.map((r) => r.finish?.latencyMs ?? 0));
  const pass =
    maxCalls <= DEFAULT_RUN_LIMITS.maxCalls &&
    maxOut <= config.limits.maxOutputTokensPerStep &&
    maxMs <= config.limits.wallClockMs;
  return { runs: store.runs.length, max_calls_per_run: maxCalls, max_output_tokens_step: maxOut, max_run_latency_ms: maxMs, pass };
}
