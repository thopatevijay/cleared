// `scenario.decide` (M2-10): "Simulate PayPal's decision (sandbox only)". The seller's request (API, audit
// actor `seller`, `detail.sandbox_decision = true`) enqueues this job; here the M2-06 disputes client calls
// the sandbox-only `POST /v1/customer-support/disputes/{id}/adjudicate` with SELLER_FAVOR. The client
// refuses outside the sandbox and re-fetches the dispute first, refusing when PayPal no longer offers
// `adjudicate`. Never retried (queue retryLimit 0; Disputes writes aren't idempotent): a refusal or an
// error clears the request so the seller can ask again once PayPal offers the step. The outcome is never
// set here: the poll mirrors it from PayPal.
import { scenarioRequestIds, WorkspaceIdSchema } from "@cleared/core";
import { DisputeActionNotAllowedError, HttpError, PayPalApiError, SandboxOnlyError } from "@cleared/adapters";
import { forWorkspace } from "@cleared/db";
import type { ConsumeContext, Handler } from "../../consume.ts";
import { runs, ScenarioJobSchema, type ScenarioDeps, type ScenarioJob } from "./shared.ts";

export type DecideOutcome = "sent" | "refused" | "skipped";

/** The refusal code stored on the run (`decision_error`) and the audit row. */
export function decisionErrorCode(error: unknown): string {
  if (error instanceof DisputeActionNotAllowedError) return "ACTION_LINK_MISSING";
  if (error instanceof SandboxOnlyError) return "SANDBOX_ONLY";
  if (error instanceof PayPalApiError) return "PAYPAL_REJECTED";
  if (error instanceof HttpError) return "PAYPAL_UNAVAILABLE";
  throw error;
}

export async function runDecideStep(
  deps: ScenarioDeps,
  job: ScenarioJob,
  ctx: ConsumeContext,
): Promise<DecideOutcome> {
  const repo = runs(deps, job);
  const run = await repo.lock(job.scenarioId, ctx.tx);
  if (
    run?.state !== "polling" ||
    run.disputeId === null ||
    run.decisionRequestedAt === null ||
    run.decisionSentAt !== null
  ) {
    ctx.log.info({ scenarioId: job.scenarioId }, "scenario decision skipped");
    return "skipped";
  }
  const audit = forWorkspace(deps.db, WorkspaceIdSchema.parse(job.workspaceId)).auditLog;
  let debugId: string | null = null;
  try {
    await deps.disputes.adjudicate(run.disputeId, "SELLER_FAVOR", {
      requestId: scenarioRequestIds(run.id).decide,
      onResponse: (m) => {
        debugId = m.debugId ?? null;
      },
    });
  } catch (error) {
    const code = decisionErrorCode(error);
    const now = deps.now();
    await repo.update(run.id, { decisionRequestedAt: null, decisionError: code, updatedAt: now }, ctx.tx);
    await audit.insert(
      {
        actor: "system",
        action: "scenario.decision_refused",
        detail: { scenarioId: run.id, disputeId: run.disputeId, code, sandbox_decision: true },
      },
      ctx.tx,
    );
    ctx.log.warn({ scenarioId: run.id, code }, "sandbox decision refused");
    return "refused";
  }
  const now = deps.now();
  await repo.update(run.id, { decisionSentAt: now, decisionError: null, updatedAt: now }, ctx.tx);
  await audit.insert(
    {
      actor: "system",
      action: "scenario.decision_sent",
      detail: {
        scenarioId: run.id,
        disputeId: run.disputeId,
        outcome: "SELLER_FAVOR",
        debugId,
        sandbox_decision: true,
      },
    },
    ctx.tx,
  );
  ctx.log.info({ scenarioId: run.id, disputeId: run.disputeId, debugId }, "sandbox decision sent");
  return "sent";
}

export function scenarioDecideHandler(deps: ScenarioDeps): Handler {
  return async (data, ctx) => {
    await runDecideStep(deps, ScenarioJobSchema.parse(data), ctx);
  };
}
