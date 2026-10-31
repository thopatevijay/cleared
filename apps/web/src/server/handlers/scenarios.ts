// M2-10 judge scenario API. Every route acts on the session's workspace only (another workspace's run is a
// 404); mutations need JSON + Origin + Idempotency-Key and replay per key. No PayPal call happens in a
// request: the start enqueues `scenario.capture`, the decision enqueues `scenario.decide` (worker).
//   GET  /api/scenarios               {available, reason, latest}
//   POST /api/scenarios               {} → 201 {scenario}   (sandbox, demo/owner workspace, one active run)
//   GET  /api/scenarios/:id           {scenario: ScenarioView}
//   POST /api/scenarios/:id/decide    {} → 202 {scenario}   "Simulate PayPal's decision (sandbox only)"
import {
  decisionAvailability,
  isStaleRun,
  parseAgentConfig,
  scenarioOutcomeKey,
  ScenarioStepsSchema,
  scenarioTimeline,
  utcDayStart,
  WorkspaceIdSchema,
  type ScenarioIndex,
  type ScenarioState,
  type ScenarioUnavailableReason,
  type ScenarioView,
  type WorkspaceId,
} from "@cleared/core";
import {
  createRunStore,
  forWorkspace,
  platform,
  SCENARIO_CAPTURE_QUEUE,
  SCENARIO_DECIDE_QUEUE,
  withTransaction,
  type Publisher,
  type ScenarioRunRow,
} from "@cleared/db";
import { z } from "zod";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal, type Session } from "../session.ts";

const IdSchema = z.uuid();
const EmptyBodySchema = z.strictObject({});

export const paypalEnv = (): string | undefined => process.env["PAYPAL_ENV"] ?? "sandbox";

/** Demo workspaces, and the owner's seller workspace (its email is on EMAIL_RECIPIENT_ALLOWLIST). */
async function eligible(deps: Deps, s: Session): Promise<boolean> {
  if (s.kind === "demo") return true;
  if (s.userId === undefined || deps.config.emailAllowlist === null) return false;
  const user = await forWorkspace(deps.db, WorkspaceIdSchema.parse(s.workspaceId)).users.get(s.userId);
  return user !== null && deps.config.emailAllowlist.includes(user.email);
}

/** The global LLM day cap (M2-02) is reached: no new scenario starts (its pack feeds AI steps). */
async function llmCapReached(deps: Deps, ws: WorkspaceId): Promise<boolean> {
  const config = parseAgentConfig(process.env);
  const spend = await createRunStore(deps.db).spend(ws, utcDayStart(deps.now().getTime()));
  return spend.globalTodayUsd >= config.dailyCapUsd;
}

async function unavailable(deps: Deps, s: Session): Promise<ScenarioUnavailableReason | null> {
  if (paypalEnv() !== "sandbox") return "not_sandbox";
  if (!(await eligible(deps, s))) return "not_eligible";
  if (await llmCapReached(deps, WorkspaceIdSchema.parse(s.workspaceId))) return "llm_cap";
  return null;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The run with PayPal's mirrored dispute and capture, the timeline and the decision gate. */
export async function scenarioView(deps: Deps, ws: WorkspaceId, run: ScenarioRunRow): Promise<ScenarioView> {
  const r = forWorkspace(deps.db, ws);
  const [dispute, payment, owner, filedAt] = await Promise.all([
    run.disputeId === null ? null : r.disputes.getByDisputeId(run.disputeId),
    run.captureId === null ? null : r.payments.getByCaptureId(run.captureId),
    run.disputeId === null ? null : platform(deps.db).resourceOwners.get("dispute", run.disputeId),
    run.disputeId === null ? null : r.scenarioRuns.evidenceFiledAt(run.disputeId),
  ]);
  const allowedActions = (dispute?.allowedActions ?? []) as string[];
  const outcomeRow = dispute?.outcome as
    { outcome_code: string; outcome_reason: string | null } | null | undefined;
  const outcome =
    outcomeRow == null
      ? null
      : { outcome_code: outcomeRow.outcome_code, outcome_reason: outcomeRow.outcome_reason };
  const state = run.state as ScenarioState;
  const outcomeKey = scenarioOutcomeKey(dispute?.status ?? null, outcome);
  const decision = decisionAvailability({
    paypalEnv: paypalEnv(),
    state,
    disputeId: run.disputeId,
    ownsDispute: dispute !== null && owner?.workspaceId === ws,
    evidenceFiled: filedAt !== null,
    allowedActions,
    decisionRequested: run.decisionRequestedAt !== null,
  });
  return {
    id: run.id,
    state,
    createdAt: run.createdAt.toISOString(),
    finishedAt: iso(run.finishedAt),
    failure: run.failure,
    timeline: scenarioTimeline({
      state,
      steps: ScenarioStepsSchema.parse(run.steps),
      evidenceFiledAt: iso(filedAt),
      decisionRequestedAt: iso(run.decisionRequestedAt ?? run.decisionSentAt),
      finishedAt: iso(run.finishedAt),
    }),
    dispute:
      dispute === null
        ? null
        : {
            disputeId: dispute.disputeId,
            status: dispute.status,
            reason: dispute.reason,
            allowedActions,
            outcome,
          },
    capture:
      payment === null
        ? null
        : { captureId: payment.captureId, status: payment.status, reason: payment.statusReason },
    outcome: outcomeKey,
    holdReleased: outcomeKey !== null && payment?.status === "COMPLETED",
    decision: {
      ...decision,
      requestedAt: iso(run.decisionRequestedAt),
      sentAt: iso(run.decisionSentAt),
      error: run.decisionError,
    },
    lastPolledAt: iso(run.lastPolledAt),
  };
}

const notFound = (req: Request): Response =>
  apiError(404, "not_found", "No such scenario in this workspace.", correlationId(req));

export async function getScenarios(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const latest = await forWorkspace(
    deps.db,
    WorkspaceIdSchema.parse(session.workspaceId),
  ).scenarioRuns.latest();
  const reason = await unavailable(deps, session);
  const body: ScenarioIndex = {
    available: reason === null,
    reason,
    latest: latest === null ? null : { id: latest.id, state: latest.state as ScenarioState },
  };
  return withRenewal(json(body), session);
}

export async function getScenario(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = WorkspaceIdSchema.parse(session.workspaceId);
  const id = IdSchema.safeParse(rawId);
  const run = id.success ? await forWorkspace(deps.db, ws).scenarioRuns.get(id.data) : null;
  if (run === null) return notFound(req);
  return withRenewal(json({ scenario: await scenarioView(deps, ws, run) }), session);
}

interface Mutation {
  readonly session: Session;
  readonly key: string;
}

async function mutation(req: Request, deps: Deps): Promise<Mutation | Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  if (!EmptyBodySchema.safeParse(await readJson(req)).success) {
    return apiError(400, "invalid_request", "The body must be an empty JSON object.", correlationId(req));
  }
  return { session, key: check.idempotencyKey };
}

const START_REFUSAL: Readonly<Record<ScenarioUnavailableReason, [number, string, string]>> = {
  not_sandbox: [404, "not_found", "The dispute scenario runs only in the PayPal sandbox."],
  not_eligible: [403, "scenario_not_available", "The dispute scenario is for demo workspaces only."],
  llm_cap: [
    429,
    "llm_cap_reached",
    "Today's AI budget for the demo is used up, so a new scenario can't start. Try again after 00:00 UTC.",
  ],
};

export async function postScenario(
  req: Request,
  deps: Deps,
  publisher: () => Promise<Publisher>,
): Promise<Response> {
  const m = await mutation(req, deps);
  if (m instanceof Response) return m;
  const reason = await unavailable(deps, m.session);
  if (reason !== null) {
    const [status, code, message] = START_REFUSAL[reason];
    return apiError(status, code, message, correlationId(req));
  }
  const ws = WorkspaceIdSchema.parse(m.session.workspaceId);
  const scope = { scopeId: m.session.sessionId, route: "POST /api/scenarios", key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const pub = await publisher();
    const r = forWorkspace(deps.db, ws);
    const out = await withTransaction(deps.db, async (tx) => {
      await r.scenarioRuns.lockStarts(tx);
      const active = await r.scenarioRuns.active(tx);
      const now = deps.now();
      if (
        active !== null &&
        !isStaleRun(active.state as ScenarioState, active.createdAt.getTime(), now.getTime())
      ) {
        return { active };
      }
      if (active !== null) {
        await r.scenarioRuns.update(
          active.id,
          { state: "timed_out", failure: "stale", finishedAt: now, updatedAt: now },
          tx,
        );
      }
      const run = await r.scenarioRuns.insert({}, tx);
      await pub.enqueue(
        tx,
        SCENARIO_CAPTURE_QUEUE,
        { scenarioId: run.id, workspaceId: ws },
        { workspaceId: ws, singletonKey: `${run.id}:capture` },
      );
      await r.auditLog.insert(
        { actor: "seller", action: "scenario.started", detail: { scenarioId: run.id, sandbox: true } },
        tx,
      );
      return { run };
    });
    if ("active" in out) {
      return json(
        {
          error: {
            code: "scenario_active",
            message: "A dispute scenario is already running in this workspace.",
            details: { scenarioId: out.active.id },
            correlationId: correlationId(req),
          },
        },
        409,
      );
    }
    return withRenewal(json({ scenario: { id: out.run.id, state: out.run.state } }, 201), m.session);
  });
}

export async function postDecide(
  req: Request,
  deps: Deps,
  publisher: () => Promise<Publisher>,
  rawId: string,
): Promise<Response> {
  const m = await mutation(req, deps);
  if (m instanceof Response) return m;
  // absent outside the sandbox: indistinguishable from a route that doesn't exist
  if (paypalEnv() !== "sandbox") return notFound(req);
  const ws = WorkspaceIdSchema.parse(m.session.workspaceId);
  const id = IdSchema.safeParse(rawId);
  const r = forWorkspace(deps.db, ws);
  const run = id.success ? await r.scenarioRuns.get(id.data) : null;
  if (run === null) return notFound(req);
  const scope = { scopeId: m.session.sessionId, route: `POST /api/scenarios/${run.id}/decide`, key: m.key };
  return withIdempotency(req, deps, scope, async () => {
    const view = await scenarioView(deps, ws, run);
    if (!view.decision.enabled) {
      return json(
        {
          error: {
            code: "decision_not_ready",
            message: "PayPal isn't ready for a decision on this dispute yet.",
            details: { reason: view.decision.reason },
            correlationId: correlationId(req),
          },
        },
        409,
      );
    }
    const pub = await publisher();
    const queued = await withTransaction(deps.db, async (tx) => {
      const locked = await r.scenarioRuns.lock(run.id, tx);
      if (locked === null || locked.decisionRequestedAt !== null || locked.decisionSentAt !== null)
        return false;
      const now = deps.now();
      await r.scenarioRuns.update(
        run.id,
        { decisionRequestedAt: now, decisionError: null, updatedAt: now },
        tx,
      );
      await r.auditLog.insert(
        {
          actor: "seller",
          action: "scenario.decision_requested",
          detail: {
            scenarioId: run.id,
            disputeId: run.disputeId,
            outcome: "SELLER_FAVOR",
            sandbox_decision: true,
          },
        },
        tx,
      );
      await pub.enqueue(
        tx,
        SCENARIO_DECIDE_QUEUE,
        { scenarioId: run.id, workspaceId: ws },
        { workspaceId: ws },
      );
      return true;
    });
    if (!queued) {
      return json(
        {
          error: {
            code: "decision_not_ready",
            message: "A decision was already requested.",
            details: { reason: "already_requested" },
            correlationId: correlationId(req),
          },
        },
        409,
      );
    }
    const fresh = await r.scenarioRuns.get(run.id);
    return withRenewal(json({ scenario: await scenarioView(deps, ws, fresh ?? run) }, 202), m.session);
  });
}
