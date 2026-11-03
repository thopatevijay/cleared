// M4-07 test support: one row in every table the retention purge empties, for one workspace. Synthetic
// values only; one statement of data-modifying CTEs so the foreign keys line up.
import { randomBytes } from "node:crypto";
import { PURGE_TABLES, type Db } from "@cleared/db";

const SEED_ALL = `
with
  pay as (insert into payments (workspace_id, capture_id, amount, currency, status, source)
    values ($1, 'RET-CAP-' || $2, 10, 'USD', 'PENDING', 'webhook') returning id),
  hold as (insert into holds (workspace_id, payment_id, type, reason, opened_at)
    select $1, id, 'capture', 'PAYMENT_REVIEW', now() from pay returning id),
  expl as (insert into explanations (workspace_id, hold_id, locale, text, source_ref)
    select $1, id, 'en', 'synthetic', 'test' from hold returning id),
  pack as (insert into proof_packs (workspace_id, payment_id) select $1, id from pay returning id),
  blob as (insert into blobs (workspace_id, mime, bytes, size, sha256)
    values ($1, 'image/png', '\\x00', 1, repeat('a', 64)) returning id),
  item as (insert into evidence_items (workspace_id, pack_id, kind, sha256, blob_id)
    select $1, pack.id, 'scope', repeat('b', 64), blob.id from pack, blob returning id),
  run as (insert into agent_runs (workspace_id, task, input_hash, model, status)
    values ($1, 'extract', repeat('c', 64), 'test-model', 'succeeded') returning id),
  step as (insert into agent_steps (workspace_id, run_id, step_index, task, status)
    select $1, id, 0, 'extract', 'succeeded' from run returning id),
  facts as (insert into extracted_facts (workspace_id, evidence_item_id, facts, model, prompt_version, run_id)
    select $1, item.id, '{}', 'test-model', 'v1', run.id from item, run returning id),
  chk as (insert into scope_checks (workspace_id, pack_id, line, verdict, check_version, evidence_set_hash,
      prompt_version, line_id, model_verdict, rationale, run_id)
    select $1, pack.id, 'line', 'met', 1, repeat('d', 64), 'v1', 'L1', 'met', 'synthetic', run.id
    from pack, run returning id),
  ack as (insert into client_acks (workspace_id, pack_id, token_hash, scope_item_id, scope_sha256, expires_at)
    select $1, pack.id, 'ret-ack-' || $2, item.id, repeat('e', 64), now() + interval '1 day'
    from pack, item returning id),
  dsp as (insert into disputes (workspace_id, dispute_id, status, payment_id)
    select $1, 'RET-DSP-' || $2, 'OPEN', id from pay returning id),
  draft as (insert into dispute_drafts (workspace_id, dispute_id, notes, pack_id, run_id, compiled_blob_id)
    select $1, dsp.id, 'synthetic', pack.id, run.id, blob.id from dsp, pack, run, blob returning id),
  act as (insert into proposed_actions (workspace_id, kind, payload, payload_sha256, risk, created_by_run_id)
    select $1, 'provide_evidence', '{}', repeat('f', 64), 'high', id from run returning id),
  appr as (insert into approvals (workspace_id, action_id, approved_by, payload_sha256)
    select $1, id, 'seller', repeat('f', 64) from act returning id),
  exe as (insert into executions (workspace_id, action_id, idempotency_key)
    select $1, id, 'ret-exe-' || $2 from act returning id),
  note as (insert into notifications (workspace_id, kind, dedupe_key)
    values ($1, 'hold.opened', 'ret-' || $2) returning id),
  scen as (insert into scenario_runs (workspace_id, state) values ($1, 'resolved') returning id),
  aud as (insert into audit_log (workspace_id, actor, action) values ($1, 'system', 'test.seed') returning id),
  own as (insert into paypal_resource_owner (resource_type, resource_id, workspace_id)
    values ('capture', 'RET-CAP-' || $2, $1) returning resource_id),
  usr as (insert into users (workspace_id, email) values ($1, 'ret-' || $2 || '@example.test') returning id),
  ses as (insert into sessions (workspace_id, kind, token_hash, expires_at, user_id)
    select $1, 'seller', 'ret-ses-' || $2, now() + interval '1 day', id from usr returning id),
  ml as (insert into magic_links (workspace_id, user_id, token_hash, expires_at, email, requested_ip_hash)
    select $1, id, 'ret-ml-' || $2, now() + interval '1 day', 'ret-' || $2 || '@example.test', 'h' from usr
    returning id)
select (select count(*) from ml) as n`;

/** Inserts one row per purge table for `workspaceId`. */
export async function seedEveryTable(db: Db, workspaceId: string): Promise<void> {
  await db.$client.query(SEED_ALL, [workspaceId, randomBytes(6).toString("hex")]);
}

/** Row counts per purge table for one workspace. */
export async function rowCounts(db: Db, workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of PURGE_TABLES) {
    const r = await db.$client.query<{ n: number }>(
      `select count(*)::int as n from "${t}" where workspace_id = $1`,
      [workspaceId],
    );
    out[t] = r.rows[0]?.n ?? -1;
  }
  return out;
}

export interface WorkspaceSpec {
  readonly kind: "demo" | "seller";
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export async function createWorkspace(db: Db, spec: WorkspaceSpec): Promise<string> {
  const r = await db.$client.query<{ id: string }>(
    `insert into workspaces (kind, timezone, base_currency, created_at, expires_at)
     values ($1, 'UTC', 'USD', $2, $3) returning id`,
    [spec.kind, spec.createdAt, spec.expiresAt],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error("workspace insert returned no row");
  return id;
}
