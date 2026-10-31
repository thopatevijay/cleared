// M2-08: the action audit trail. `audit_log` is append-only (0002 trigger, 0006 grants): this module only
// inserts and reads. Every row about an action carries `detail.actionId`; `at` is `clock_timestamp()`, so
// rows written in one transaction still sort in the order they were written.
import { and, asc, eq, sql } from "drizzle-orm";
import type { AuditActor, JsonValue } from "@cleared/core";
import type { Db } from "../client.ts";
import type { Executor } from "../tx.ts";
import { auditLog } from "../../schema/index.ts";

export interface ActionAuditEntry {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly actor: AuditActor;
  /** e.g. `action.approved`, `action.check`, `action.sent`, `action.succeeded` */
  readonly action: string;
  readonly detail?: Readonly<Record<string, JsonValue>>;
}

export interface ActionAuditRow {
  readonly at: Date;
  readonly actor: AuditActor;
  readonly action: string;
  readonly detail: Record<string, unknown>;
}

export async function appendActionAudit(db: Db, e: ActionAuditEntry, tx?: Executor): Promise<void> {
  await (tx ?? db).insert(auditLog).values({
    workspaceId: e.workspaceId,
    at: sql`clock_timestamp()`,
    actor: e.actor,
    action: e.action,
    detail: { ...e.detail, actionId: e.actionId },
  });
}

/** The action's trail in write order, inside its workspace. */
export async function actionAuditTrail(
  db: Db,
  workspaceId: string,
  actionId: string,
  tx?: Executor,
): Promise<ActionAuditRow[]> {
  const rows = await (tx ?? db)
    .select({ at: auditLog.at, actor: auditLog.actor, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, workspaceId), sql`${auditLog.detail}->>'actionId' = ${actionId}`))
    .orderBy(asc(auditLog.at));
  return rows.map((r) => ({ ...r, detail: r.detail as Record<string, unknown> }));
}
