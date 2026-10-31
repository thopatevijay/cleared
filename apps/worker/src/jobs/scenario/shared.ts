// M2-10: what every judge-scenario step job shares. A step locks its run (`for update`) in the consumer's
// transaction and acts only when the run is in that step's state (core `advance`): a re-delivered or late
// job finds another state, logs and returns without calling PayPal. The step's state change and the next
// step's job are written in that same transaction (ADR 0004).
import {
  advance,
  ScenarioStepsSchema,
  WorkspaceIdSchema,
  type ScenarioState,
  type ScenarioStep,
  type ScenarioSteps,
} from "@cleared/core";
import type { PayPalCapturesClient, PayPalDisputesClient, PayPalOrdersClient } from "@cleared/adapters";
import { forWorkspace, type Db, type Publisher, type ScenarioRunRow } from "@cleared/db";
import { z } from "zod";
import type { ConsumeContext } from "../../consume.ts";

export const ScenarioJobSchema = z.object({ scenarioId: z.uuid(), workspaceId: z.uuid() });
export type ScenarioJob = z.infer<typeof ScenarioJobSchema>;

export interface ScenarioDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly orders: Pick<PayPalOrdersClient, "createOrder" | "confirmCard" | "captureOrder">;
  readonly captures: Pick<PayPalCapturesClient, "getCapture">;
  readonly disputes: Pick<
    PayPalDisputesClient,
    "getDispute" | "listDisputes" | "processChargeback" | "adjudicate"
  >;
  readonly now: () => Date;
}

export type StepOutcome = "done" | "skipped";

export const runs = (deps: Pick<ScenarioDeps, "db">, job: ScenarioJob) =>
  forWorkspace(deps.db, WorkspaceIdSchema.parse(job.workspaceId)).scenarioRuns;

export interface LockedStep {
  readonly run: ScenarioRunRow;
  readonly steps: ScenarioSteps;
  /** the state this step moves the run to */
  readonly next: ScenarioState;
}

/** The run locked for this step, or null (logged) when the step must not act. */
export async function lockForStep(
  deps: Pick<ScenarioDeps, "db">,
  job: ScenarioJob,
  step: ScenarioStep,
  ctx: ConsumeContext,
): Promise<LockedStep | null> {
  const run = await runs(deps, job).lock(job.scenarioId, ctx.tx);
  const next = run === null ? null : advance(run.state as ScenarioState, step);
  if (run === null || next === null) {
    ctx.log.info({ scenarioId: job.scenarioId, step, state: run?.state ?? null }, "scenario step skipped");
    return null;
  }
  return { run, steps: ScenarioStepsSchema.parse(run.steps), next };
}

/** Enqueues the next step's job in the step's transaction; one job per (run, step). */
export async function enqueueStep(
  deps: Pick<ScenarioDeps, "publisher">,
  ctx: ConsumeContext,
  queue: string,
  job: ScenarioJob,
  opts: { readonly key: string; readonly startAfter?: Date } = { key: queue },
): Promise<void> {
  await deps.publisher.enqueue(ctx.tx, queue, job, {
    workspaceId: job.workspaceId,
    singletonKey: `${job.scenarioId}:${opts.key}`,
    ...(opts.startAfter === undefined ? {} : { startAfter: opts.startAfter }),
  });
}
