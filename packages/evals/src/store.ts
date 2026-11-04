// The eval's RunStore: the harness's persistence port kept in memory, shaped like `agent_runs` /
// `agent_steps` so the report reads cost, calls and latency per run from the same records the product
// writes. The harness reserves each call's worst case here before it leaves (M4-05), against one cap:
// `EVAL_MAX_USD` for the whole eval run (workspace and daily cap alike). There is no content-hash cache: every
// eval item is a real run.
import {
  parseAgentConfig,
  type AgentConfig,
  type ReserveRequest,
  type RunFinish,
  type RunStart,
  type RunStore,
  type StepRecord,
  type WorkspaceId,
} from "@cleared/core";

export const EVAL_WORKSPACE = "00000000-0000-4000-8000-0000000e7a1d" as WorkspaceId;

export interface RunRecord extends RunStart {
  readonly id: string;
  /** settled cost (reservations replaced by billed cost as each step lands) */
  costUsd: number;
  finish?: RunFinish;
}

export interface EvalStore extends RunStore {
  readonly runs: RunRecord[];
  readonly steps: StepRecord[];
  /** USD settled so far across the whole eval run (reservations included while a call is in flight) */
  spentUsd(): number;
}

export function createEvalStore(): EvalStore {
  const runs: RunRecord[] = [];
  const steps: StepRecord[] = [];
  const spentUsd = (): number => runs.reduce((a, r) => a + r.costUsd, 0);
  return {
    runs,
    steps,
    spentUsd,
    killSwitch: () => Promise.resolve(false),
    spend: () =>
      Promise.resolve({
        workspaceKind: "demo",
        workspaceCapUsd: null,
        workspaceUsd: spentUsd(),
        globalTodayUsd: spentUsd(),
      }),
    reserve: (r: ReserveRequest) => {
      // single-threaded JS: read, decide and add happen without an await in between (the SQL store locks)
      const decision = r.decide({
        workspaceKind: "demo",
        workspaceCapUsd: null,
        workspaceUsd: spentUsd(),
        globalTodayUsd: spentUsd(),
      });
      const run = runs.find((x) => x.id === r.runId);
      if (decision.ok && run) run.costUsd += r.usd;
      return Promise.resolve(decision);
    },
    findCachedOutput: () => Promise.resolve(null),
    startRun: (run: RunStart) => {
      const id = `run-${String(runs.length + 1)}`;
      runs.push({ ...run, id, costUsd: 0 });
      return Promise.resolve(id);
    },
    recordStep: (step: StepRecord) => {
      steps.push(step);
      const run = runs.find((r) => r.id === step.runId);
      if (run) run.costUsd += step.costUsd - (step.reservedUsd ?? 0);
      return Promise.resolve();
    },
    finishRun: (finish: RunFinish) => {
      const run = runs.find((r) => r.id === finish.runId);
      if (run) run.finish = finish;
      return Promise.resolve({ proposedActionIds: finish.proposals.map((_, i) => `eval-action-${String(i + 1)}`) });
    },
  };
}

/** The harness config for an eval run: the pinned (or env) models, and `capUsd` as both caps. */
export function evalConfig(env: Readonly<Record<string, string | undefined>>, capUsd: number): AgentConfig {
  const base = parseAgentConfig({
    OPENAI_MODEL_SMALL: env.OPENAI_MODEL_SMALL,
    OPENAI_MODEL_LARGE: env.OPENAI_MODEL_LARGE,
  });
  return { ...base, killSwitchEnv: false, workspaceCapUsd: capUsd, dailyCapUsd: capUsd };
}
