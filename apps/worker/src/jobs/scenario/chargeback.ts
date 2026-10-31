// `scenario.chargeback` (M2-10 step 3): the sandbox-only `POST /v2/customer-support/process-chargeback` on
// the scenario's capture (M0-05: reason C2 → MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED). The new dispute is
// claimed for the workspace in `paypal_resource_owner` in this transaction (dispute sync would also
// inherit it from the capture), the run starts polling and the first poll is scheduled 30 s out.
// Disputes v1 ignores PayPal-Request-Id as an idempotency key (M0-05), so `openScenarioChargeback` lists
// the capture's disputes first: a retry adopts the dispute an earlier attempt created.
import { SCENARIO_AMOUNT, SCENARIO_POLL_INTERVAL_MS, scenarioRequestIds } from "@cleared/core";
import { openScenarioChargeback } from "@cleared/adapters";
import { platform, SCENARIO_POLL_QUEUE } from "@cleared/db";
import type { ConsumeContext, Handler } from "../../consume.ts";
import {
  enqueueStep,
  lockForStep,
  runs,
  ScenarioJobSchema,
  type ScenarioDeps,
  type ScenarioJob,
  type StepOutcome,
} from "./shared.ts";

export async function runChargebackStep(
  deps: ScenarioDeps,
  job: ScenarioJob,
  ctx: ConsumeContext,
): Promise<StepOutcome> {
  const locked = await lockForStep(deps, job, "chargeback", ctx);
  if (locked === null) return "skipped";
  const { run, steps, next } = locked;
  const merchantId = steps.capture?.merchantId ?? null;
  if (run.captureId === null || merchantId === null) {
    throw new Error(`scenario ${run.id}: no capture or payee merchant id for the chargeback`);
  }
  const cb = await openScenarioChargeback(deps.disputes, {
    captureId: run.captureId,
    amount: SCENARIO_AMOUNT,
    merchantId,
    requestId: scenarioRequestIds(run.id).chargeback,
  });
  await platform(deps.db).resourceOwners.claim(
    { resourceType: "dispute", resourceId: cb.disputeId, workspaceId: job.workspaceId },
    ctx.tx,
  );
  const now = deps.now();
  await runs(deps, job).update(
    run.id,
    {
      state: next,
      disputeId: cb.disputeId,
      pollStartedAt: now,
      steps: {
        ...steps,
        chargeback: { at: now.toISOString(), disputeId: cb.disputeId, adopted: cb.adopted },
      },
      updatedAt: now,
    },
    ctx.tx,
  );
  await enqueueStep(deps, ctx, SCENARIO_POLL_QUEUE, job, {
    key: "poll:1",
    startAfter: new Date(now.getTime() + SCENARIO_POLL_INTERVAL_MS),
  });
  ctx.log.info(
    { scenarioId: run.id, disputeId: cb.disputeId, adopted: cb.adopted },
    "scenario chargeback opened",
  );
  return "done";
}

export function scenarioChargebackHandler(deps: ScenarioDeps): Handler {
  return async (data, ctx) => {
    await runChargebackStep(deps, ScenarioJobSchema.parse(data), ctx);
  };
}
