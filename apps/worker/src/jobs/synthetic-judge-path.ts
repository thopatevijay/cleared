// M3-09 daily synthetic judge path (ADR 0013): proves the hosted demo still works unattended, once per UTC
// day (03:00, `ops.synthetic`) and on demand (`pnpm --filter ./apps/worker run synthetic`).
// It acts as a judge would, in its own demo workspace flagged `synthetic` (left out of the demo caps and the
// SLO samples): it starts the M2-10 scenario (a real sandbox card capture with `custom_id`, the chargeback,
// the canned synthetic evidence), waits for the M2-07 `provide_evidence` proposal and approves it as the
// seller (bound to its payload sha256), asks for the labelled sandbox decision once PayPal offers it, and
// waits for the dispute RESOLVED and the capture back to COMPLETED. Every step runs in the normal worker
// queues; this runner only starts the run, makes the two seller decisions and watches the database.
// Each step's time is one `ops_checks` row (`synthetic.<step>`) plus the run's own row (`synthetic`, pass
// = end to end in ≤ 30 min). A failure raises a Sentry error naming the failing step. The workspace is purged
// afterwards, pass or fail.
import {
  SYNTHETIC_CRON,
  SYNTHETIC_MAX_SECONDS,
  SYNTHETIC_STEPS,
  syntheticRunCheck,
  syntheticStepCheck,
  type OpsCheckResult,
  type SyntheticStep,
} from "@cleared/core";
import { reportError, reportWarning, type Logger } from "@cleared/adapters";
import {
  OPS_SYNTHETIC_QUEUE,
  platform,
  purgeSyntheticWorkspace,
  withTransaction,
  type Db,
  type Publisher,
  type Queue,
} from "@cleared/db";
import { startSyntheticRun, syntheticProbes, type ProbeState } from "./synthetic-steps.ts";
import { cronWorkOptions } from "../poll-intervals.ts";

export interface SyntheticDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly now: () => Date;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
  /** how often a step re-reads the database (default 5 s) */
  readonly pollMs?: number;
  /** the hard end-to-end limit (default 30 min, core `SYNTHETIC_MAX_SECONDS`); step targets are soft */
  readonly maxSeconds?: number;
  /** the Sentry error for a failed run (the adapter by default; tests pass a spy) */
  readonly alert?: (error: Error, extra: Record<string, unknown>) => void;
}

export interface SyntheticStepTime {
  readonly step: SyntheticStep;
  readonly seconds: number;
  readonly pass: boolean;
}

export interface SyntheticResult {
  readonly pass: boolean;
  readonly failedStep: SyntheticStep | null;
  readonly error: string | null;
  readonly totalSeconds: number;
  readonly steps: readonly SyntheticStepTime[];
  readonly workspaceId: string;
  readonly scenarioId: string;
  readonly captureId: string | null;
  readonly disputeId: string | null;
  readonly purged: boolean;
  /** the run's OpenAI spend (its `agent_runs`, kept by the purge) */
  readonly aiCostUsd: number;
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secondsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;

/** Re-probes until done, a failure (thrown), or `untilMs`. */
async function waitFor(
  deps: SyntheticDeps,
  untilMs: number,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  for (;;) {
    if (await probe()) return true;
    if (deps.now().getTime() >= untilMs) return false;
    await (deps.sleep ?? sleepFor)(deps.pollMs ?? 5_000);
  }
}

interface Walk {
  readonly steps: SyntheticStepTime[];
  failedStep: SyntheticStep | null;
  error: string | null;
}

async function walkSteps(deps: SyntheticDeps, state: ProbeState, start: Date): Promise<Walk> {
  const walk: Walk = { steps: [], failedStep: null, error: null };
  const deadline = start.getTime() + (deps.maxSeconds ?? SYNTHETIC_MAX_SECONDS) * 1000;
  const probes = syntheticProbes(deps, state);
  let prev = start;
  for (const { step } of SYNTHETIC_STEPS) {
    let done = false;
    try {
      done = await waitFor(deps, deadline, probes[step]);
    } catch (error) {
      walk.error = error instanceof Error ? error.message : String(error);
    }
    const at = deps.now();
    const seconds = secondsBetween(prev, at);
    walk.steps.push({ step, seconds, pass: done && syntheticStepCheck(step, seconds).pass });
    deps.log.info({ step, seconds, done }, "synthetic step");
    if (!done) {
      walk.failedStep = step;
      walk.error ??= `no ${step} within the end-to-end limit`;
      return walk;
    }
    prev = at;
  }
  return walk;
}

function rowsOf(walk: Walk, total: number, aiCostUsd: number): OpsCheckResult[] {
  const steps = walk.steps.map((s) => ({ ...syntheticStepCheck(s.step, s.seconds), pass: s.pass }));
  const slow = walk.steps.filter((s) => !s.pass && s.step !== walk.failedStep).map((s) => s.step);
  const run = syntheticRunCheck(total, walk.failedStep, slow);
  return [...steps, { ...run, detail: { ...run.detail, error: walk.error, aiCostUsd } }];
}

async function purge(deps: SyntheticDeps, workspaceId: string): Promise<boolean> {
  try {
    await withTransaction(deps.db, (tx) => purgeSyntheticWorkspace(workspaceId, tx));
    return true;
  } catch (error) {
    // the workspace stays synthetic (out of the caps and the samples) and expired (ADR 0013 addendum)
    deps.log.error({ workspaceId, err: error }, "synthetic workspace purge failed");
    reportWarning("synthetic workspace purge failed", {
      workspaceKind: "demo",
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

/** One end-to-end synthetic run: timings stored, Sentry on failure, workspace purged. */
export async function runSyntheticJudgePath(deps: SyntheticDeps): Promise<SyntheticResult> {
  const start = deps.now();
  const state = await startSyntheticRun(deps);
  const walk = await walkSteps(deps, state, start);
  const totalSeconds = secondsBetween(start, deps.now());
  const aiCostUsd = await platform(deps.db).opsChecks.workspaceAiCostUsd(state.workspaceId);
  const rows = rowsOf(walk, totalSeconds, aiCostUsd);
  const pass = rows.at(-1)?.pass === true;
  await platform(deps.db).opsChecks.insert(
    rows.map((r) => ({
      runAt: deps.now(),
      check: r.check,
      value: r.value,
      target: r.target,
      pass: r.pass,
      detail: r.detail,
    })),
  );
  const ids = { scenarioId: state.scenarioId, captureId: state.captureId, disputeId: state.disputeId };
  if (!pass) {
    const failedStep = walk.failedStep ?? "total_time";
    const extra = { failedStep, error: walk.error, totalSeconds, ...ids };
    const error = new Error(`synthetic judge path failed at ${failedStep}`);
    if (deps.alert === undefined) reportError(error, { workspaceKind: "demo", extra });
    else deps.alert(error, extra);
  }
  const purged = await purge(deps, state.workspaceId);
  deps.log.info({ pass, totalSeconds, failedStep: walk.failedStep, purged, ...ids }, "synthetic judge path");
  return {
    pass,
    failedStep: walk.failedStep,
    error: walk.error,
    totalSeconds,
    steps: walk.steps,
    workspaceId: state.workspaceId,
    purged,
    aiCostUsd,
    ...ids,
  };
}

/** A run's ceiling: the 30-minute path plus the purge (pg-boss fails the job after this). */
export const SYNTHETIC_EXPIRE_SECONDS = 40 * 60;

/**
 * Schedules the run once per UTC day on a singleton queue (one at a time; never retried: tomorrow's run
 * is the retry, and the SLO check `slo.synthetic_fresh` alerts when no run has passed for 26 h).
 */
export async function scheduleSynthetic(
  deps: SyntheticDeps & { readonly boss: Queue; readonly pollingIntervalSeconds?: number },
): Promise<void> {
  if (!(await deps.boss.getQueue(OPS_SYNTHETIC_QUEUE))) {
    await deps.boss.createQueue(OPS_SYNTHETIC_QUEUE, {
      policy: "singleton",
      expireInSeconds: SYNTHETIC_EXPIRE_SECONDS,
      retryLimit: 0,
    });
  }
  await deps.boss.schedule(OPS_SYNTHETIC_QUEUE, SYNTHETIC_CRON);
  await deps.boss.work(OPS_SYNTHETIC_QUEUE, cronWorkOptions(deps), async () => {
    await runSyntheticJudgePath(deps);
  });
}
