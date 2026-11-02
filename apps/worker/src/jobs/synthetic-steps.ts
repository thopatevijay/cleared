// M3-09: the synthetic judge path's start and its step probes. Each probe reads the database (the worker's
// queues do the work) and returns true once its step is done; it throws when the run can no longer pass
// (the scenario failed or timed out, the filing failed). Two probes act, once each, as the judge would:
// `evidence_filed` approves the M2-07 proposal (bound to its payload sha256) and `sandbox_decision` asks
// for the labelled sandbox decision once PayPal offers `adjudicate` (the M2-10 web route's transaction).
import { WorkspaceIdSchema, type SyntheticStep, type WorkspaceId } from "@cleared/core";
import {
  approveProposedAction,
  forWorkspace,
  getProposedAction,
  platform,
  SCENARIO_CAPTURE_QUEUE,
  SCENARIO_DECIDE_QUEUE,
  withTransaction,
  type Db,
  type Publisher,
  type ScenarioRunRow,
} from "@cleared/db";
import { z } from "zod";

export interface SyntheticStepDeps {
  readonly db: Db;
  readonly publisher: Publisher;
  readonly now: () => Date;
}

/** What the probes learn as the run goes. */
export interface ProbeState {
  readonly workspaceId: WorkspaceId;
  readonly scenarioId: string;
  captureId: string | null;
  disputeId: string | null;
  actionId: string | null;
}

/** The synthetic workspace lives at most this long if its purge ever fails. */
export const SYNTHETIC_WORKSPACE_TTL_MS = 2 * 60 * 60_000;
export const SYNTHETIC_ACTOR = "synthetic";

/** Creates the synthetic workspace and starts its scenario (the first step's job), in one transaction. */
export async function startSyntheticRun(deps: SyntheticStepDeps): Promise<ProbeState> {
  return withTransaction(deps.db, async (tx) => {
    const now = deps.now();
    const ws = await platform(deps.db).workspaces.create(
      {
        kind: "demo",
        locale: "en",
        timezone: "UTC",
        baseCurrency: "USD",
        synthetic: true,
        expiresAt: new Date(now.getTime() + SYNTHETIC_WORKSPACE_TTL_MS),
        llmBudgetUsd: "0.10",
      },
      tx,
    );
    const workspaceId = WorkspaceIdSchema.parse(ws.id);
    const repos = forWorkspace(deps.db, workspaceId);
    const run = await repos.scenarioRuns.insert({}, tx);
    await deps.publisher.enqueue(
      tx,
      SCENARIO_CAPTURE_QUEUE,
      { scenarioId: run.id, workspaceId },
      { workspaceId, singletonKey: `${run.id}:capture` },
    );
    await repos.auditLog.insert(
      {
        actor: "system",
        action: "scenario.started",
        detail: { scenarioId: run.id, sandbox: true, synthetic: true },
      },
      tx,
    );
    return { workspaceId, scenarioId: run.id, captureId: null, disputeId: null, actionId: null };
  });
}

type Probe = () => Promise<boolean>;

const PayloadSchema = z.object({ dispute_id: z.string() });

async function liveRun(deps: SyntheticStepDeps, s: ProbeState): Promise<ScenarioRunRow> {
  const run = await forWorkspace(deps.db, s.workspaceId).scenarioRuns.get(s.scenarioId);
  if (run === null) throw new Error("the scenario run is gone");
  if (run.state === "failed" || run.state === "timed_out") {
    throw new Error(`scenario ${run.state}: ${run.failure ?? "no reason"}`);
  }
  return run;
}

async function payment(deps: SyntheticStepDeps, s: ProbeState) {
  return s.captureId === null
    ? null
    : forWorkspace(deps.db, s.workspaceId).payments.getByCaptureId(s.captureId);
}

async function findProposal(deps: SyntheticStepDeps, s: ProbeState): Promise<boolean> {
  await liveRun(deps, s);
  const rows = await forWorkspace(deps.db, s.workspaceId).proposedActions.list({ limit: 50 });
  const mine = rows.find(
    (r) =>
      r.kind === "provide_evidence" &&
      r.state === "proposed" &&
      PayloadSchema.safeParse(r.payload).data?.dispute_id === s.disputeId,
  );
  if (mine === undefined) return false;
  s.actionId = mine.id;
  return true;
}

async function fileEvidence(deps: SyntheticStepDeps, s: ProbeState): Promise<boolean> {
  if (s.actionId === null) throw new Error("no proposal to approve");
  const row = await getProposedAction(deps.db, s.workspaceId, s.actionId);
  if (row?.state === "succeeded") return true;
  if (row?.state === "failed") throw new Error(`filing failed: ${row.refusalCode ?? "unknown"}`);
  if (row?.state !== "proposed") return false;
  const r = await approveProposedAction(deps.db, deps.publisher, {
    workspaceId: s.workspaceId,
    actionId: row.id,
    actor: SYNTHETIC_ACTOR,
    now: deps.now(),
    payloadSha256: row.payloadSha256,
  });
  if (!r.ok) throw new Error(`approval refused: ${r.code}`);
  return false;
}

/** The M2-10 decision request (web `postDecide`), actor `system`, labelled sandbox and synthetic. */
async function requestDecision(deps: SyntheticStepDeps, s: ProbeState): Promise<void> {
  const repos = forWorkspace(deps.db, s.workspaceId);
  await withTransaction(deps.db, async (tx) => {
    const run = await repos.scenarioRuns.lock(s.scenarioId, tx);
    if (run === null || run.decisionRequestedAt !== null || run.decisionSentAt !== null) return;
    const now = deps.now();
    await repos.scenarioRuns.update(
      run.id,
      { decisionRequestedAt: now, decisionError: null, updatedAt: now },
      tx,
    );
    const detail = {
      scenarioId: run.id,
      disputeId: run.disputeId,
      outcome: "SELLER_FAVOR",
      sandbox_decision: true,
    };
    await repos.auditLog.insert(
      { actor: "system", action: "scenario.decision_requested", detail: { ...detail, synthetic: true } },
      tx,
    );
    const job = { scenarioId: run.id, workspaceId: s.workspaceId };
    await deps.publisher.enqueue(tx, SCENARIO_DECIDE_QUEUE, job, { workspaceId: s.workspaceId });
  });
}

async function decide(deps: SyntheticStepDeps, s: ProbeState): Promise<boolean> {
  const run = await liveRun(deps, s);
  if (run.decisionSentAt !== null) return true;
  if (run.decisionRequestedAt !== null || s.disputeId === null) return false;
  const repos = forWorkspace(deps.db, s.workspaceId);
  const [filedAt, dispute] = await Promise.all([
    repos.scenarioRuns.evidenceFiledAt(s.disputeId),
    repos.disputes.getByDisputeId(s.disputeId),
  ]);
  const links = z.array(z.string()).catch([]).parse(dispute?.allowedActions);
  if (filedAt !== null && links.includes("adjudicate")) await requestDecision(deps, s);
  return false;
}

async function released(deps: SyntheticStepDeps, s: ProbeState): Promise<boolean> {
  const run = await forWorkspace(deps.db, s.workspaceId).scenarioRuns.get(s.scenarioId);
  if (run?.state !== "resolved") {
    await liveRun(deps, s); // throws once the scenario failed or timed out
    return false;
  }
  const p = await payment(deps, s);
  if (p?.status !== "COMPLETED") throw new Error(`dispute resolved, capture ${p?.status ?? "missing"}`);
  return true;
}

export function syntheticProbes(deps: SyntheticStepDeps, s: ProbeState): Record<SyntheticStep, Probe> {
  return {
    capture: async () => {
      s.captureId = (await liveRun(deps, s)).captureId;
      return s.captureId !== null;
    },
    chargeback: async () => {
      s.disputeId = (await liveRun(deps, s)).disputeId;
      return s.disputeId !== null;
    },
    buyer_complaint_hold: async () => {
      await liveRun(deps, s);
      const p = await payment(deps, s);
      return p?.status === "PENDING" && p.statusReason === "BUYER_COMPLAINT";
    },
    evidence_proposed: () => findProposal(deps, s),
    evidence_filed: () => fileEvidence(deps, s),
    sandbox_decision: () => decide(deps, s),
    released: () => released(deps, s),
  };
}
