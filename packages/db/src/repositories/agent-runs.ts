// M2-02: the harness's RunStore over agent_runs / agent_steps / proposed_actions / audit_log /
// platform_flags. Spend is read from agent_runs (each step adds its cost to its run as it is recorded),
// so the budget check before every call sees the current run's spend too.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type {
  JsonValue,
  RunFinish,
  RunStart,
  RunStore,
  Sha256,
  SpendSnapshot,
  StepRecord,
  WorkspaceId,
} from "@cleared/core";
import type { Db } from "../client.ts";
import { platformFlagsRepo } from "../repos/platform/flags.ts";
import { withTransaction } from "../tx.ts";
import { agentRuns, agentSteps, auditLog, workspaces } from "../../schema/index.ts";
import { insertProposedActions } from "./proposed-actions.ts";

/** numeric(…) without a scale: 8 decimals keeps every measured call cost (≥ $0.00001) exact enough. */
const usd = (n: number): string => n.toFixed(8);

export function createRunStore(db: Db, now: () => Date = () => new Date()): RunStore {
  return {
    killSwitch: () => platformFlagsRepo(db).agentKillSwitch(),
    spend: (workspaceId, dayStart) => readSpend(db, workspaceId, dayStart),
    findCachedOutput: (workspaceId, task, inputHash) => findCached(db, workspaceId, task, inputHash),
    async startRun(run: RunStart) {
      const rows = await db
        .insert(agentRuns)
        .values({
          workspaceId: run.workspaceId,
          task: run.task,
          promptVersion: run.promptVersion,
          model: run.model,
          inputHash: run.inputHash,
          correlationId: run.correlationId,
          status: run.status,
        })
        .returning({ id: agentRuns.id });
      const id = rows[0]?.id;
      if (!id) throw new Error("agent_runs insert returned no row");
      return id;
    },
    recordStep: (step) => recordStep(db, step),
    finishRun: (finish) => finishRun(db, finish, now()),
  };
}

async function readSpend(db: Db, workspaceId: WorkspaceId, dayStart: Date): Promise<SpendSnapshot> {
  const ws = await db
    .select({ kind: workspaces.kind, cap: workspaces.llmBudgetUsd })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = ws[0];
  if (!row) throw new Error(`workspace ${workspaceId} not found`);
  const [mine] = await db
    .select({ usd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId));
  const [today] = await db
    .select({ usd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
    .from(agentRuns)
    .where(gte(agentRuns.createdAt, dayStart));
  return {
    workspaceKind: row.kind,
    workspaceCapUsd: row.cap === null ? null : Number(row.cap),
    workspaceUsd: Number(mine?.usd ?? 0),
    globalTodayUsd: Number(today?.usd ?? 0),
  };
}

async function findCached(
  db: Db,
  workspaceId: WorkspaceId,
  task: string,
  inputHash: Sha256,
): Promise<{ runId: string; output: JsonValue } | null> {
  const rows = await db
    .select({ id: agentRuns.id, output: agentRuns.output })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        eq(agentRuns.task, task),
        eq(agentRuns.inputHash, inputHash),
        eq(agentRuns.status, "succeeded"),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const hit = rows[0];
  return hit && hit.output !== null ? { runId: hit.id, output: hit.output as JsonValue } : null;
}

async function recordStep(db: Db, s: StepRecord): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.insert(agentSteps).values({
      workspaceId: s.workspaceId,
      runId: s.runId,
      stepIndex: s.stepIndex,
      kind: s.kind,
      task: s.name,
      model: s.model,
      inputHash: s.inputHash,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      costUsd: usd(s.costUsd),
      latencyMs: s.latencyMs,
      status: s.status,
      detail: s.detail,
      correlationId: s.correlationId,
    });
    if (s.tokensIn === 0 && s.tokensOut === 0 && s.costUsd === 0) return;
    await tx
      .update(agentRuns)
      .set({
        tokensIn: sql`${agentRuns.tokensIn} + ${s.tokensIn}`,
        tokensOut: sql`${agentRuns.tokensOut} + ${s.tokensOut}`,
        costUsd: sql`${agentRuns.costUsd} + ${usd(s.costUsd)}::numeric`,
      })
      .where(and(eq(agentRuns.id, s.runId), eq(agentRuns.workspaceId, s.workspaceId)));
  });
}

/** One transaction: the run's result, its proposals (+ outbox rows) and the audit entry. */
async function finishRun(db: Db, f: RunFinish, at: Date): Promise<{ proposedActionIds: string[] }> {
  return withTransaction(db, async (tx) => {
    const updated = await tx
      .update(agentRuns)
      .set({ status: f.status, output: f.output, error: f.error, latencyMs: f.latencyMs })
      .where(and(eq(agentRuns.id, f.runId), eq(agentRuns.workspaceId, f.workspaceId)))
      .returning({
        model: agentRuns.model,
        promptVersion: agentRuns.promptVersion,
        costUsd: agentRuns.costUsd,
      });
    const run = updated[0];
    if (!run) throw new Error(`agent run ${f.runId} not found in its workspace`);
    const proposals = f.proposals.map((proposal) => ({
      workspaceId: f.workspaceId,
      runId: f.runId,
      proposal,
      at,
    }));
    const proposedActionIds = await insertProposedActions(db, proposals, tx);
    await tx.insert(auditLog).values({
      workspaceId: f.workspaceId,
      actor: "agent",
      action: `agent_run.${f.status}`,
      detail: {
        runId: f.runId,
        task: f.task,
        promptVersion: run.promptVersion,
        model: run.model,
        costUsd: run.costUsd,
        correlationId: f.correlationId,
        proposedActionIds,
        error: f.error,
      },
    });
    return { proposedActionIds };
  });
}
