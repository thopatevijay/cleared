// M2-10: judge scenario runs, scoped to one workspace. The step jobs lock their run (`for update`) so two
// deliveries of the same step can't both act; `active()` backs the one-active-run rule.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { SCENARIO_ACTIVE_STATES } from "@cleared/core";
import type { Db } from "../../client.ts";
import * as s from "../../../schema/index.ts";
import type { Executor } from "../../tx.ts";
import { isUuid, mutableScopedRepo, type Row } from "./scoped.ts";

export type ScenarioRunRow = Row<typeof s.scenarioRuns>;

export function scenarioRunsRepo(db: Db, ws: string) {
  const inScope = eq(s.scenarioRuns.workspaceId, ws);
  return {
    ...mutableScopedRepo(db, s.scenarioRuns, ws),
    /** The run row locked for this transaction; null when it is not this workspace's. */
    async lock(id: string, tx: Executor): Promise<ScenarioRunRow | null> {
      if (!isUuid(id)) return null;
      const rows = await tx
        .select()
        .from(s.scenarioRuns)
        .where(and(inScope, eq(s.scenarioRuns.id, id)))
        .for("update")
        .limit(1);
      return rows[0] ?? null;
    },
    /** The workspace's active run (at most one, by the partial unique index). */
    async active(tx?: Executor): Promise<ScenarioRunRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(s.scenarioRuns)
        .where(and(inScope, inArray(s.scenarioRuns.state, [...SCENARIO_ACTIVE_STATES])))
        .limit(1);
      return rows[0] ?? null;
    },
    async latest(tx?: Executor): Promise<ScenarioRunRow | null> {
      const rows = await (tx ?? db)
        .select()
        .from(s.scenarioRuns)
        .where(inScope)
        .orderBy(desc(s.scenarioRuns.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    /**
     * When this workspace's `provide_evidence` for the PayPal dispute succeeded (M2-08 execution), or null.
     * "Our evidence was filed" for the sandbox decision control.
     */
    async evidenceFiledAt(disputeId: string, tx?: Executor): Promise<Date | null> {
      // the time is the `action.succeeded` audit row (M2-08 writes it with the state change)
      const rows = await (tx ?? db)
        .select({ at: s.auditLog.at })
        .from(s.proposedActions)
        .innerJoin(
          s.auditLog,
          and(
            eq(s.auditLog.workspaceId, ws),
            eq(s.auditLog.action, "action.succeeded"),
            sql`${s.auditLog.detail}->>'actionId' = ${s.proposedActions.id}::text`,
          ),
        )
        .where(
          and(
            eq(s.proposedActions.workspaceId, ws),
            eq(s.proposedActions.kind, "provide_evidence"),
            eq(s.proposedActions.state, "succeeded"),
            sql`${s.proposedActions.payload}->>'dispute_id' = ${disputeId}`,
          ),
        )
        .orderBy(s.auditLog.at)
        .limit(1);
      return rows[0]?.at ?? null;
    },
  };
}
