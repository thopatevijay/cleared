// `scenario.capture` (M2-10 step 1): a real sandbox card order + capture of $120.00 USD with
// `custom_id = workspace_id` (M1-04 `createOwnedTestPayment`: the order's owner row is committed before
// the capture exists). Then, in this job's transaction: the capture's owner row, the `payments` mirror and
// the `payment.captured` outbox row (capture sync, re-fetched from PayPal), the run's next state and the
// seed job. A retry reuses the run id as the PayPal-Request-Id root, so PayPal replays the first order.
import { SCENARIO_AMOUNT, scenarioRequestIds } from "@cleared/core";
import { createOwnedTestPayment } from "@cleared/adapters";
import { platform, SCENARIO_SEED_PACK_QUEUE } from "@cleared/db";
import type { ConsumeContext, Handler } from "../../consume.ts";
import { syncCapture } from "../capture-sync.ts";
import {
  enqueueStep,
  lockForStep,
  runs,
  ScenarioJobSchema,
  type ScenarioDeps,
  type ScenarioJob,
  type StepOutcome,
} from "./shared.ts";

export async function runCaptureStep(
  deps: ScenarioDeps,
  job: ScenarioJob,
  ctx: ConsumeContext,
): Promise<StepOutcome> {
  const locked = await lockForStep(deps, job, "capture", ctx);
  if (locked === null) return "skipped";
  const { run, steps, next } = locked;
  const owners = platform(deps.db).resourceOwners;
  const paid = await createOwnedTestPayment(
    {
      orders: deps.orders,
      // on the pool, not ctx.tx: the owner must exist before PayPal can announce the capture (ADR 0008)
      claimOrder: async (orderId, workspaceId) => {
        await owners.claim({ resourceType: "order", resourceId: orderId, workspaceId });
      },
    },
    { workspaceId: job.workspaceId, requestId: scenarioRequestIds(run.id).payment, amount: SCENARIO_AMOUNT },
  );
  await syncCapture(deps, { captureId: paid.captureId, source: "poll" }, ctx);
  const now = deps.now();
  await runs(deps, job).update(
    run.id,
    {
      state: next,
      orderId: paid.orderId,
      captureId: paid.captureId,
      steps: {
        ...steps,
        capture: {
          at: now.toISOString(),
          orderId: paid.orderId,
          captureId: paid.captureId,
          status: paid.status,
          merchantId: paid.merchantId,
        },
      },
      updatedAt: now,
    },
    ctx.tx,
  );
  await enqueueStep(deps, ctx, SCENARIO_SEED_PACK_QUEUE, job);
  ctx.log.info({ scenarioId: run.id, orderId: paid.orderId, captureId: paid.captureId }, "scenario captured");
  return "done";
}

export function scenarioCaptureHandler(deps: ScenarioDeps): Handler {
  return async (data, ctx) => {
    await runCaptureStep(deps, ScenarioJobSchema.parse(data), ctx);
  };
}
