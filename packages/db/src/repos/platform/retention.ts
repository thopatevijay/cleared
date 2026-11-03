// M4-07 (ADR 0020): the demo retention purge's reads and its one write. The write is the SECURITY DEFINER
// function `purge_workspace(uuid)` (migration 0019), owned by `cleared_purger`: the app role holds EXECUTE
// on it and still no DELETE on `audit_log`. Which workspaces are due is core's `isPurgeDue`, not SQL.
import { sql } from "drizzle-orm";
import type { Db } from "../../client.ts";
import type { Executor, Tx } from "../../tx.ts";

/** The tables `purge_workspace` empties for one workspace, children first (same order as the function). */
export const PURGE_TABLES = [
  "explanations",
  "approvals",
  "executions",
  "dispute_drafts",
  "client_acks",
  "extracted_facts",
  "scope_checks",
  "evidence_items",
  "proposed_actions",
  "proof_packs",
  "holds",
  "disputes",
  "payments",
  "blobs",
  "agent_steps",
  "agent_runs",
  "notifications",
  "scenario_runs",
  "audit_log",
  "paypal_resource_owner",
  "sessions",
  "magic_links",
  "users",
] as const;
export type PurgeTable = (typeof PURGE_TABLES)[number];

/** Per-table row counts, plus the review-hold pool rows detached from the workspace (ADR 0019). */
export type PurgeCounts = Record<PurgeTable | "review_hold_pool_detached", number>;

/** A demo workspace not yet purged (never the review-hold pool workspace). */
export interface RetentionCandidate {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly synthetic: boolean;
}

/** The platform audit row `purge_workspace` writes (workspace_id null; counts only). */
export const RETENTION_PURGED_ACTION = "retention.purged";

const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];

export function retentionRepo(db: Db) {
  return {
    /** Unpurged demo workspaces, optionally only among `ids` (a manual run or a test). */
    async candidates(ids?: readonly string[], tx?: Executor): Promise<RetentionCandidate[]> {
      if (ids?.length === 0) return [];
      const only = ids === undefined ? sql`` : sql`and w.id::text in ${ids}`;
      const r = await (tx ?? db).execute(sql`
        select w.id, w.created_at as "createdAt", w.expires_at as "expiresAt", w.synthetic
        from workspaces w
        where w.kind = 'demo' and w.purged_at is null
          and not exists (select 1 from review_hold_pool p where p.pool_workspace_id = w.id)
          ${only}
        order by w.created_at`);
      return rowsOf<{
        id: string;
        createdAt: Date | string;
        expiresAt: Date | string | null;
        synthetic: boolean;
      }>(r).map((x) => ({
        id: x.id,
        createdAt: new Date(x.createdAt),
        expiresAt: x.expiresAt === null ? null : new Date(x.expiresAt),
        synthetic: x.synthetic,
      }));
    },
    /** What a purge of `workspaceId` would remove (the dry run): one count per table, nothing changed. */
    async counts(workspaceId: string, tx?: Executor): Promise<PurgeCounts> {
      const parts = PURGE_TABLES.map(
        (t) =>
          sql`(select count(*) from ${sql.identifier(t)} where workspace_id = ${workspaceId})::int as ${sql.identifier(t)}`,
      );
      const r = await (tx ?? db).execute(sql`
        select ${sql.join(parts, sql`, `)},
          (select count(*) from review_hold_pool where assigned_workspace_id = ${workspaceId})::int
            as review_hold_pool_detached`);
      const row = rowsOf<PurgeCounts>(r)[0];
      if (row === undefined) throw new Error("count query returned no row");
      return row;
    },
    /** Empties one demo workspace through `purge_workspace` (definer), in `tx`; returns what it removed. */
    async purge(workspaceId: string, tx: Tx): Promise<PurgeCounts> {
      const r = await tx.execute(sql`select purge_workspace(${workspaceId}::uuid) as counts`);
      const counts = rowsOf<{ counts: PurgeCounts }>(r)[0]?.counts;
      if (counts === undefined) throw new Error("purge_workspace returned no counts");
      return counts;
    },
  };
}
