// `scenario.poll` (M2-10 step 4): every 30 s, a targeted dispute sync and capture sync for this run's ids
// only (works without webhooks, e.g. on a local stack). It stops at a terminal state (dispute RESOLVED and
// the capture no longer PENDING) or 60 minutes after the chargeback; a finished run schedules nothing, and
// a late poll job for a finished run is a no-op (`lockForStep`). States are only ever PayPal's, mirrored by
// the M2-06 / M1-04 syncs; the run records what it observed.
import {
  pollExpired,
  pollVerdict,
  recordMilestones,
  SCENARIO_POLL_INTERVAL_MS,
  WorkspaceIdSchema,
  type PollVerdict,
} from "@cleared/core";
import { forWorkspace, SCENARIO_POLL_QUEUE } from "@cleared/db";
import type { ConsumeContext, Handler } from "../../consume.ts";
import { syncCapture } from "../capture-sync.ts";
import { syncDispute } from "../dispute-sync.ts";
import {
  enqueueStep,
  lockForStep,
  runs,
  ScenarioJobSchema,
  type ScenarioDeps,
  type ScenarioJob,
} from "./shared.ts";

export type PollOutcome = PollVerdict | "skipped";

export async function runPollStep(
  deps: ScenarioDeps,
  job: ScenarioJob,
  ctx: ConsumeContext,
): Promise<PollOutcome> {
  const locked = await lockForStep(deps, job, "poll", ctx);
  if (locked === null) return "skipped";
  const { run, steps } = locked;
  const repo = runs(deps, job);
  if (run.disputeId === null || run.captureId === null || run.pollStartedAt === null) {
    throw new Error(`scenario ${run.id} is polling without a dispute`);
  }
  const startedMs = run.pollStartedAt.getTime();
  if (pollExpired(startedMs, deps.now().getTime())) {
    const now = deps.now();
    await repo.update(
      run.id,
      { state: "timed_out", failure: "poll_limit", finishedAt: now, updatedAt: now },
      ctx.tx,
    );
    ctx.log.warn({ scenarioId: run.id }, "scenario poll gave up after 60 minutes");
    return "timed_out";
  }
  await syncDispute(deps, { disputeId: run.disputeId, source: "poll" }, ctx);
  await syncCapture(deps, { captureId: run.captureId, source: "poll" }, ctx);
  const ws = forWorkspace(deps.db, WorkspaceIdSchema.parse(job.workspaceId));
  const dispute = await ws.disputes.getByDisputeId(run.disputeId, ctx.tx);
  const payment = await ws.payments.getByCaptureId(run.captureId, ctx.tx);
  const observed = { disputeStatus: dispute?.status ?? null, captureStatus: payment?.status ?? null };
  const captureReason = payment?.statusReason ?? null;
  const now = deps.now();
  const verdict = pollVerdict(startedMs, now.getTime(), observed);
  const polls = run.polls + 1;
  await repo.update(
    run.id,
    {
      state: verdict === "continue" ? "polling" : verdict,
      polls,
      lastPolledAt: now,
      steps: {
        ...steps,
        poll: { at: now.toISOString(), count: polls, ...observed, captureReason },
        seen: recordMilestones(
          steps.seen ?? {},
          {
            ...observed,
            captureReason,
            allowedActions: (dispute?.allowedActions ?? []) as string[],
            outcomeCode: (dispute?.outcome as { outcome_code?: string } | null)?.outcome_code ?? null,
          },
          now.toISOString(),
        ),
      },
      ...(verdict === "continue" ? {} : { finishedAt: now }),
      ...(verdict === "timed_out" ? { failure: "poll_limit" } : {}),
      updatedAt: now,
    },
    ctx.tx,
  );
  if (verdict === "continue") {
    await enqueueStep(deps, ctx, SCENARIO_POLL_QUEUE, job, {
      key: `poll:${String(polls + 1)}`,
      startAfter: new Date(now.getTime() + SCENARIO_POLL_INTERVAL_MS),
    });
  }
  ctx.log.info({ scenarioId: run.id, polls, ...observed, verdict }, "scenario polled");
  return verdict;
}

export function scenarioPollHandler(deps: ScenarioDeps): Handler {
  return async (data, ctx) => {
    await runPollStep(deps, ScenarioJobSchema.parse(data), ctx);
  };
}
