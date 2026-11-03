// M2-09: the read models behind the dispute screens and the workspace audit log. Every query is bound to
// one workspace. `audit_log` is only read here (append-only). The audit page is cursor-paginated on
// (at, id), newest first; `at` is compared as Postgres text so microsecond ties never skip or repeat a row.
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { Executor } from "../tx.ts";
import * as s from "../../schema/index.ts";
import { DRAFT_AUDIT_ACTIONS } from "./dispute-drafts.ts";

/** The audit action dispute sync writes when PayPal's status changes (detail: paypalDisputeId, from, to, outcome). */
export const DISPUTE_STATUS_AUDIT = "dispute.status_changed";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_ACTOR_FILTERS = ["seller", "agent", "system", "sandbox"] as const;
export type AuditActorFilter = (typeof AUDIT_ACTOR_FILTERS)[number];
export const AUDIT_KIND_FILTERS = ["disputes", "tracking", "signin", "sandbox"] as const;
export type AuditKindFilter = (typeof AUDIT_KIND_FILTERS)[number];

export interface AuditCursor {
  /** `audit_log.at` as Postgres text (microseconds kept) */
  readonly at: string;
  readonly id: string;
}

export interface AuditQuery {
  readonly cursor?: AuditCursor | null;
  readonly actor?: AuditActorFilter | null;
  readonly kind?: AuditKindFilter | null;
  /** an ID fragment: dispute ID, debug_id, fingerprint, action or scenario id (callers restrict the charset) */
  readonly q?: string | null;
  /** one dispute's trail: its proposals' rows, its drafting outcomes and its mirrored status changes */
  readonly dispute?: { readonly rowId: string; readonly paypalId: string } | null;
  readonly limit?: number;
}

export interface AuditPageRow {
  readonly id: string;
  readonly at: Date;
  readonly atText: string;
  readonly actor: "seller" | "agent" | "system";
  readonly action: string;
  readonly detail: Record<string, unknown>;
  /** the PayPal dispute the row's action targets (from the proposal's payload), if any */
  readonly paypalDisputeId: string | null;
  readonly actionKind: string | null;
}

const field = (k: string): SQL<string | null> => sql<string | null>`${s.auditLog.detail}->>${k}`;
const likeEscape = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

function actorFilter(a: AuditActorFilter): SQL | undefined {
  const sandbox = sql`coalesce(${field("sandbox_decision")}, '') = 'true'`;
  if (a === "sandbox") return sandbox;
  return and(eq(s.auditLog.actor, a), sql`not (${sandbox})`);
}

function kindFilter(k: AuditKindFilter): SQL | undefined {
  const like = (p: string) => ilike(s.auditLog.action, p);
  const tracking = or(sql`${s.proposedActions.kind}::text = 'add_tracking'`, like("tracking.%"));
  switch (k) {
    case "disputes":
      return and(
        or(like("action.%"), like("dispute%")),
        or(isNull(s.proposedActions.kind), sql`${s.proposedActions.kind}::text <> 'add_tracking'`),
      );
    case "tracking":
      return tracking;
    case "signin":
      return or(like("auth.%"), like("demo.%"), like("session.%"));
    case "sandbox":
      return or(like("scenario.%"), like("sandbox.%"));
  }
}

function idFilter(q: string): SQL | undefined {
  const p = `%${likeEscape(q)}%`;
  const keys = ["debugId", "paypalDisputeId", "payloadSha256", "actionId", "scenarioId", "correlationId"];
  return or(
    ...keys.map((k) => sql`${field(k)} ilike ${p}`),
    sql`${s.proposedActions.payload}->>'dispute_id' ilike ${p}`,
  );
}

function disputeFilter(d: { rowId: string; paypalId: string }): SQL | undefined {
  return or(
    sql`${s.proposedActions.payload}->>'dispute_id' = ${d.paypalId}`,
    and(ilike(s.auditLog.action, "dispute_draft.%"), sql`${field("disputeId")} = ${d.rowId}`),
    and(eq(s.auditLog.action, DISPUTE_STATUS_AUDIT), sql`${field("paypalDisputeId")} = ${d.paypalId}`),
  );
}

/** One page of the workspace's audit log, newest first, and the cursor of the next (older) page. */
export async function auditPage(
  db: Db,
  workspaceId: string,
  q: AuditQuery = {},
  tx?: Executor,
): Promise<{ rows: AuditPageRow[]; next: AuditCursor | null }> {
  const limit = Math.max(1, Math.min(200, Math.trunc(q.limit ?? AUDIT_PAGE_SIZE)));
  const where = and(
    eq(s.auditLog.workspaceId, workspaceId),
    q.cursor
      ? sql`(${s.auditLog.at}, ${s.auditLog.id}) < (${q.cursor.at}::timestamptz, ${q.cursor.id}::uuid)`
      : undefined,
    q.actor ? actorFilter(q.actor) : undefined,
    q.kind ? kindFilter(q.kind) : undefined,
    q.q ? idFilter(q.q) : undefined,
    q.dispute ? disputeFilter(q.dispute) : undefined,
  );
  const rows = await (tx ?? db)
    .select({
      id: s.auditLog.id,
      at: s.auditLog.at,
      atText: sql<string>`${s.auditLog.at}::text`,
      actor: s.auditLog.actor,
      action: s.auditLog.action,
      detail: s.auditLog.detail,
      paypalDisputeId: sql<string | null>`${s.proposedActions.payload}->>'dispute_id'`,
      actionKind: sql<string | null>`${s.proposedActions.kind}::text`,
    })
    .from(s.auditLog)
    .leftJoin(
      s.proposedActions,
      and(
        eq(s.proposedActions.workspaceId, workspaceId),
        sql`${s.proposedActions.id}::text = ${field("actionId")}`,
      ),
    )
    .where(where)
    .orderBy(desc(s.auditLog.at), desc(s.auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({ ...r, detail: r.detail as Record<string, unknown> }));
  const last = page.at(-1);
  return { rows: page, next: rows.length > limit && last ? { at: last.atText, id: last.id } : null };
}

export type DisputeListRow = Awaited<ReturnType<typeof disputeList>>[number];

/** The workspace's disputes with the linked payment, soonest reply due first (no due date last). */
export async function disputeList(db: Db, workspaceId: string, tx?: Executor) {
  return (tx ?? db)
    .select({
      dispute: s.disputes,
      payment: {
        id: s.payments.id,
        captureId: s.payments.captureId,
        amount: s.payments.amount,
        currency: s.payments.currency,
        status: s.payments.status,
        statusReason: s.payments.statusReason,
      },
    })
    .from(s.disputes)
    .leftJoin(
      s.payments,
      and(eq(s.payments.id, s.disputes.paymentId), eq(s.payments.workspaceId, workspaceId)),
    )
    .where(eq(s.disputes.workspaceId, workspaceId))
    .orderBy(sql`${s.disputes.sellerResponseDueDate} asc nulls last`, asc(s.disputes.createdAt))
    .limit(200);
}

export interface DraftWithAction {
  readonly draft: typeof s.disputeDrafts.$inferSelect;
  readonly actionState: string | null;
}

/** The drafts of these disputes (newest first) with their proposal's state. */
export async function draftsWithActions(
  db: Db,
  workspaceId: string,
  disputeRowIds: readonly string[],
  tx?: Executor,
): Promise<DraftWithAction[]> {
  if (disputeRowIds.length === 0) return [];
  return (tx ?? db)
    .select({ draft: s.disputeDrafts, actionState: sql<string | null>`${s.proposedActions.state}::text` })
    .from(s.disputeDrafts)
    .leftJoin(
      s.proposedActions,
      and(
        eq(s.proposedActions.workspaceId, workspaceId),
        eq(s.proposedActions.id, s.disputeDrafts.proposedActionId),
      ),
    )
    .where(
      and(
        eq(s.disputeDrafts.workspaceId, workspaceId),
        inArray(s.disputeDrafts.disputeId, [...disputeRowIds]),
      ),
    )
    .orderBy(desc(s.disputeDrafts.createdAt), desc(s.disputeDrafts.id));
}

/** The newest seller-created `accept_claim` proposal on this PayPal dispute, if any. */
export async function latestAcceptClaim(db: Db, workspaceId: string, paypalDisputeId: string, tx?: Executor) {
  const rows = await (tx ?? db)
    .select()
    .from(s.proposedActions)
    .where(
      and(
        eq(s.proposedActions.workspaceId, workspaceId),
        sql`${s.proposedActions.kind}::text = 'accept_claim'`,
        sql`${s.proposedActions.payload}->>'dispute_id' = ${paypalDisputeId}`,
      ),
    )
    .orderBy(desc(s.proposedActions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** The latest "not drafted" outcome (`dispute_draft.unavailable` / `too_late`) for our dispute row. */
export async function latestDraftOutcome(db: Db, workspaceId: string, disputeRowId: string, tx?: Executor) {
  const rows = await (tx ?? db)
    .select({ at: s.auditLog.at, action: s.auditLog.action, detail: s.auditLog.detail })
    .from(s.auditLog)
    .where(
      and(
        eq(s.auditLog.workspaceId, workspaceId),
        // not `dispute_draft.evidence_added`: that one comes with a draft (BL-01 6595501766)
        inArray(s.auditLog.action, [DRAFT_AUDIT_ACTIONS.unavailable, DRAFT_AUDIT_ACTIONS.tooLate]),
        sql`${field("disputeId")} = ${disputeRowId}`,
      ),
    )
    .orderBy(desc(s.auditLog.at))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, detail: r.detail as Record<string, unknown> } : null;
}

/** The judge scenario run on this PayPal dispute (M2-10), newest first. */
export async function scenarioForDispute(
  db: Db,
  workspaceId: string,
  paypalDisputeId: string,
  tx?: Executor,
) {
  const rows = await (tx ?? db)
    .select({ id: s.scenarioRuns.id })
    .from(s.scenarioRuns)
    .where(and(eq(s.scenarioRuns.workspaceId, workspaceId), eq(s.scenarioRuns.disputeId, paypalDisputeId)))
    .orderBy(desc(s.scenarioRuns.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** A blob's size and mime without its bytes (the compiled PDF's line on the dispute screen). */
export async function blobMeta(db: Db, workspaceId: string, blobId: string, tx?: Executor) {
  const rows = await (tx ?? db)
    .select({ size: s.blobs.size, mime: s.blobs.mime, sha256: s.blobs.sha256 })
    .from(s.blobs)
    .where(and(eq(s.blobs.workspaceId, workspaceId), eq(s.blobs.id, blobId)))
    .limit(1);
  return rows[0] ?? null;
}
