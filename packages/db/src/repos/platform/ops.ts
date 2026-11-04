// M3-09 operations reads and writes, across workspaces (platform scope; never handed to a client):
// - `ops_checks` rows (the reconcile tick, the SLO checks, the synthetic judge path)
// - what the reconcile poll re-reads: owned captures, open disputes and stranded `unknown` actions.
//   Only resources with an owner row in their own workspace are listed: an unowned or foreign resource is
//   never fetched.
// - the SLO samples
// - the synthetic workspace purge
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../../client.ts";
import { opsChecks, workspaces } from "../../../schema/index.ts";
import type { Executor, Tx } from "../../tx.ts";

export type OpsCheckRow = typeof opsChecks.$inferSelect;
export type NewOpsCheck = Omit<typeof opsChecks.$inferInsert, "id">;

export interface PollCapture {
  readonly workspaceId: string;
  readonly captureId: string;
  readonly status: string;
}
export interface PollDispute {
  readonly workspaceId: string;
  readonly disputeId: string;
}
export interface StrandedAction {
  readonly workspaceId: string;
  readonly actionId: string;
  readonly kind: string;
  /** the `action.unknown` audit row's `before` snapshot (M3-09), when recorded */
  readonly before: unknown;
}
/** A pack whose scope check may never have been triggered (BL-01 6537991625), with one of its facts rows. */
export interface StuckPack {
  readonly workspaceId: string;
  readonly packId: string;
  readonly evidenceItemId: string;
  readonly factsId: string;
  readonly runId: string;
}

export interface DeadlineRow {
  readonly disputeId: string;
  readonly status: string;
  readonly dueAt: Date | null;
  readonly filed: boolean;
}

const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];
const MAX_ITEMS = 2_000;

export function opsChecksRepo(db: Db) {
  return {
    async insert(rows: readonly NewOpsCheck[], tx?: Executor): Promise<void> {
      if (rows.length > 0) await (tx ?? db).insert(opsChecks).values([...rows]);
    },
    /** The newest row of `check` (optionally only passing ones, or only up to `before`), or null. */
    async latest(
      check: string,
      opts: { pass?: boolean; before?: Date } = {},
      tx?: Executor,
    ): Promise<OpsCheckRow | null> {
      const where = and(
        eq(opsChecks.check, check),
        opts.pass === undefined ? undefined : eq(opsChecks.pass, opts.pass),
        opts.before === undefined ? undefined : lte(opsChecks.runAt, opts.before),
      );
      const rows = await (tx ?? db)
        .select()
        .from(opsChecks)
        .where(where)
        .orderBy(desc(opsChecks.runAt))
        .limit(1);
      return rows[0] ?? null;
    },
    /** The AI spend of one workspace's agent runs, in USD (the synthetic run records its own). */
    async workspaceAiCostUsd(workspaceId: string, tx?: Executor): Promise<number> {
      const r = await (tx ?? db).execute(
        sql`select coalesce(sum(cost_usd), 0)::float8 as usd from agent_runs where workspace_id = ${workspaceId}`,
      );
      return Number(rowsOf<{ usd: number | string }>(r)[0]?.usd ?? 0);
    },
    /** Whether a breach of `check` raised its alert (`detail.alerted`) in [since, until] (the SLO throttle). */
    async alertedBetween(check: string, since: Date, until: Date, tx?: Executor): Promise<boolean> {
      const rows = await (tx ?? db)
        .select({ id: opsChecks.id })
        .from(opsChecks)
        .where(
          and(
            eq(opsChecks.check, check),
            gte(opsChecks.runAt, since),
            lte(opsChecks.runAt, until),
            sql`${opsChecks.detail}->>'alerted' = 'true'`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}

/**
 * M4-06: a load-test workspace's rows are seeded, not mirrored from PayPal (loadtest.ts), so the poll never
 * fetches them: PayPal doesn't know those ids.
 */
export const LOADTEST_TAG = "loadtest";

export function reconcileTargetsRepo(db: Db) {
  return {
    /** Owned captures that are PENDING, or that PayPal changed since `recentSince`. */
    async captures(recentSince: Date, tx?: Executor): Promise<PollCapture[]> {
      const r = await (tx ?? db).execute(sql`
        select p.workspace_id as "workspaceId", p.capture_id as "captureId", p.status as "status"
        from payments p
        join paypal_resource_owner o
          on o.resource_type = 'capture' and o.resource_id = p.capture_id and o.workspace_id = p.workspace_id
        join workspaces w on w.id = p.workspace_id and w.created_ip_hash is distinct from ${LOADTEST_TAG}
        where p.status = 'PENDING' or p.paypal_updated_at >= ${recentSince}
        order by p.paypal_updated_at desc nulls last
        limit ${MAX_ITEMS}`);
      return rowsOf<PollCapture>(r);
    },
    /** Owned disputes PayPal has not RESOLVED. */
    async disputes(tx?: Executor): Promise<PollDispute[]> {
      const r = await (tx ?? db).execute(sql`
        select d.workspace_id as "workspaceId", d.dispute_id as "disputeId"
        from disputes d
        join paypal_resource_owner o
          on o.resource_type = 'dispute' and o.resource_id = d.dispute_id and o.workspace_id = d.workspace_id
        join workspaces w on w.id = d.workspace_id and w.created_ip_hash is distinct from ${LOADTEST_TAG}
        where d.status <> 'RESOLVED'
        order by d.seller_response_due_date asc nulls last
        limit ${MAX_ITEMS}`);
      return rowsOf<PollDispute>(r);
    },
    /**
     * BL-01 6537991625: `collecting` packs where at least one item has facts and at least one ended without
     * them (`extract.no_facts`), never re-checked by the sweeper (`pack.scope_recheck`). The caller still
     * confirms no item is awaiting extraction before it nudges the scope check.
     */
    async stuckPacks(tx?: Executor): Promise<StuckPack[]> {
      const r = await (tx ?? db).execute(sql`
        select p.workspace_id as "workspaceId", p.id as "packId",
          f.evidence_item_id as "evidenceItemId", f.id as "factsId", f.run_id as "runId"
        from proof_packs p
        join lateral (
          select f.id, f.evidence_item_id, f.run_id from extracted_facts f
          join evidence_items e on e.id = f.evidence_item_id
          where e.pack_id = p.id and f.run_id is not null
          order by f.created_at desc limit 1
        ) f on true
        where p.state = 'collecting'
          and exists (
            select 1 from audit_log l join evidence_items e on l.detail->>'evidenceItemId' = e.id::text
            where l.workspace_id = p.workspace_id and l.action = 'extract.no_facts' and e.pack_id = p.id)
          and not exists (
            select 1 from audit_log l
            where l.workspace_id = p.workspace_id and l.action = 'pack.scope_recheck'
              and l.detail->>'packId' = p.id::text)
        limit ${MAX_ITEMS}`);
      return rowsOf<StuckPack>(r);
    },
    /** `unknown` actions with no audit activity since `quietSince`: their reconcile chain is lost. */
    async strandedActions(quietSince: Date, tx?: Executor): Promise<StrandedAction[]> {
      const r = await (tx ?? db).execute(sql`
        select a.workspace_id as "workspaceId", a.id as "actionId", a.kind,
          (select l.detail->'before' from audit_log l
            where l.workspace_id = a.workspace_id and l.action = 'action.unknown'
              and l.detail->>'actionId' = a.id::text
            order by l.at desc limit 1) as before
        from proposed_actions a
        where a.state = 'unknown'
          and not exists (
            select 1 from audit_log l
            where l.workspace_id = a.workspace_id and l.detail->>'actionId' = a.id::text
              and l.at >= ${quietSince})
        limit ${MAX_ITEMS}`);
      return rowsOf<StrandedAction>(r);
    },
  };
}

export function sloSamplesRepo(db: Db) {
  return {
    /**
     * Webhook received → hold visible, in seconds, for holds created since `since`: the latest webhook at
     * or before the `holds` row that **announced** that hold (M3-GATE prep). Recorded shapes
     * (fixtures/paypal/webhooks/deliveries):
     * - a capture hold: a `PAYMENT.CAPTURE.*` delivery about the capture (`resource.id`) whose resource is
     *   `PENDING` with the hold's `status_details.reason`. A `COMPLETED` capture delivery never counts:
     *   pairing a dispute hold with it measured PayPal's chargeback clock (~200 s), not Cleared's.
     * - a dispute hold (`type = 'dispute'`): a `CUSTOMER.DISPUTE.*` delivery (`resource.dispute_id`) whose
     *   `disputed_transactions` lists the capture as `seller_transaction_id`; the capture re-sync that
     *   delivery triggers is what shows the hold.
     * Holds no webhook announced (poll, scenario, a webhook that arrived after the hold) have no sample.
     * Synthetic workspaces are excluded.
     */
    async holdVisibleSeconds(since: Date, until: Date, tx?: Executor): Promise<number[]> {
      const r = await (tx ?? db).execute(sql`
        select extract(epoch from (h.created_at - w.received_at))::float8 as s
        from holds h
        join payments p on p.id = h.payment_id
        join workspaces ws on ws.id = h.workspace_id and not ws.synthetic
        join lateral (
          select e.received_at from webhook_events e
          where e.provider = 'paypal' and e.received_at <= h.created_at
            and (
              (e.raw->'resource'->>'id' = p.capture_id
                and e.raw->'resource'->>'status' = 'PENDING'
                and e.raw->'resource'->'status_details'->>'reason' = h.reason)
              or (h.type = 'dispute'
                and e.raw->'resource'->>'dispute_id' is not null
                and e.raw->'resource'->'disputed_transactions'
                  @> jsonb_build_array(jsonb_build_object('seller_transaction_id', p.capture_id)))
            )
          order by e.received_at desc limit 1
        ) w on true
        where h.created_at >= ${since} and h.created_at <= ${until}`);
      return rowsOf<{ s: number | string }>(r).map((x) => Number(x.s));
    },
    /** Seller approval → the PayPal send that answered 2xx, in seconds, for approvals since `since`. */
    async approvedToPaypalSeconds(since: Date, until: Date, tx?: Executor): Promise<number[]> {
      const r = await (tx ?? db).execute(sql`
        select extract(epoch from (e.created_at - a.approved_at))::float8 as s
        from approvals a
        join executions e on e.action_id = a.action_id and e.workspace_id = a.workspace_id
        join workspaces ws on ws.id = a.workspace_id and not ws.synthetic
        where a.approved_at >= ${since} and a.approved_at <= ${until} and e.paypal_status ~ '^2[0-9][0-9]$'`);
      return rowsOf<{ s: number | string }>(r).map((x) => Number(x.s));
    },
    /** Every non-synthetic dispute with a due date, and whether one of its actions succeeded. */
    async deadlines(tx?: Executor): Promise<DeadlineRow[]> {
      const r = await (tx ?? db).execute(sql`
        select d.dispute_id as "disputeId", d.status, d.seller_response_due_date as "dueAt",
          exists (
            select 1 from proposed_actions a
            where a.workspace_id = d.workspace_id and a.state = 'succeeded'
              and a.payload->>'dispute_id' = d.dispute_id) as filed
        from disputes d
        join workspaces ws on ws.id = d.workspace_id and not ws.synthetic
        where d.seller_response_due_date is not null and d.status <> 'RESOLVED'
        limit ${MAX_ITEMS}`);
      return rowsOf<{ disputeId: string; status: string; dueAt: Date | string | null; filed: boolean }>(
        r,
      ).map((x) => ({ ...x, dueAt: x.dueAt === null ? null : new Date(x.dueAt) }));
    },
  };
}

/**
 * Child tables first (foreign keys). Kept on purpose: `agent_runs` / `agent_steps` (the AI spend the global
 * day cap counts) and the workspace row itself (flagged synthetic and expired, so the kept runs keep their
 * foreign key). Neither holds evidence or personal data.
 */
const PURGE_ORDER = [
  "explanations",
  "approvals",
  "executions",
  "proposed_actions",
  "dispute_drafts",
  "client_acks",
  "extracted_facts",
  "scope_checks",
  "evidence_items",
  "proof_packs",
  "holds",
  "disputes",
  "payments",
  "blobs",
  "notifications",
  "scenario_runs",
  "audit_log",
  "paypal_resource_owner",
  "sessions",
  "magic_links",
  "users",
] as const;
/** Append-only tables (migrations 0002, 0006 and the scope-check trigger). */
const APPEND_ONLY: readonly { table: string; trigger: string }[] = [
  { table: "audit_log", trigger: "audit_log_append_only" },
  { table: "evidence_items", trigger: "evidence_items_append_only" },
  { table: "scope_checks", trigger: "scope_checks_append_only" },
];

/** Thrown before anything changes when this role can't lift the append-only guards (not owner, not superuser). */
export class PurgeNotPermittedError extends Error {
  override readonly name = "PurgeNotPermittedError";
}

/**
 * `alter table … disable trigger` and `grant`/`revoke` need the table's owner (or a superuser). Checked up
 * front, so a role without them refuses cleanly instead of failing half-way (the transaction would roll
 * back either way). Callers keep the workspace flagged synthetic and expired then (ADR 0013 addendum).
 */
async function assertCanLiftGuards(tx: Tx): Promise<void> {
  const r = await tx.execute(sql`
    select t.tablename as "table",
      (t.tableowner = current_user or r.rolsuper) as ok
    from pg_tables t join pg_roles r on r.rolname = current_user
    where t.schemaname = 'public' and t.tablename in ('audit_log', 'evidence_items', 'scope_checks')`);
  const rows = rowsOf<{ table: string; ok: boolean }>(r);
  const missing = APPEND_ONLY.filter((a) => rows.find((x) => x.table === a.table)?.ok !== true);
  if (missing.length > 0) {
    throw new PurgeNotPermittedError(
      `cannot lift the append-only guards on ${missing.map((m) => m.table).join(", ")}: not the owner`,
    );
  }
}

/**
 * Deletes every row of a **synthetic** workspace, in `tx` (M3-09). Refuses any other workspace. The
 * append-only guards are lifted for this transaction only, as migration 0006 prescribes for a purge: the
 * trigger is disabled and DELETE granted inside the transaction, then both restored before it commits.
 */
export async function purgeSyntheticWorkspace(workspaceId: string, tx: Tx): Promise<number> {
  const ws = await tx
    .select({ synthetic: workspaces.synthetic })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update");
  if (ws[0]?.synthetic !== true) throw new Error(`refusing to purge non-synthetic workspace ${workspaceId}`);
  await assertCanLiftGuards(tx);
  await tx.execute(sql`set local lock_timeout = '5s'`);
  const granted: string[] = [];
  for (const { table, trigger } of APPEND_ONLY) {
    await tx.execute(sql.raw(`alter table "${table}" disable trigger "${trigger}"`));
    const p = await tx.execute(sql`select has_table_privilege(${table}, 'DELETE') as ok`);
    if (rowsOf<{ ok: boolean }>(p)[0]?.ok !== true) {
      await tx.execute(sql.raw(`grant delete on table "${table}" to current_user`));
      granted.push(table);
    }
  }
  // expired now, so a capture or dispute sync racing this purge writes nothing afterwards (BL-01 6594517545)
  await tx.execute(
    sql`update workspaces set expires_at = least(coalesce(expires_at, now()), now()) where id = ${workspaceId}`,
  );
  let deleted = 0;
  for (const table of PURGE_ORDER) {
    const r = await tx.execute(sql`delete from ${sql.identifier(table)} where workspace_id = ${workspaceId}`);
    deleted += r.rowCount ?? 0;
  }
  for (const table of granted)
    await tx.execute(sql.raw(`revoke delete on table "${table}" from current_user`));
  for (const { table, trigger } of APPEND_ONLY) {
    await tx.execute(sql.raw(`alter table "${table}" enable trigger "${trigger}"`));
  }
  return deleted;
}
