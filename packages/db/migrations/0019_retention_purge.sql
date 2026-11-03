-- M4-07 (ADR 0020): the demo retention purge. `purge_workspace(uuid)` is a SECURITY DEFINER function owned
-- by the NOLOGIN role `cleared_purger`, the only role the append-only trigger lets DELETE. The app role keeps
-- no DELETE grant on audit_log (0006) and its own DELETE still raises (0002); it only gets EXECUTE.
ALTER TABLE "workspaces" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cleared_purger') THEN
    CREATE ROLE cleared_purger NOLOGIN NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
-- The append-only guard (0002, 0009): DELETE passes only inside purge_workspace, where current_user is the
-- definer. UPDATE and TRUNCATE still raise for every role.
CREATE OR REPLACE FUNCTION cleared_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'cleared_purger' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
GRANT SELECT, DELETE ON TABLE
  "explanations", "approvals", "executions", "dispute_drafts", "client_acks", "extracted_facts",
  "scope_checks", "evidence_items", "proposed_actions", "proof_packs", "holds", "disputes", "payments",
  "blobs", "agent_steps", "agent_runs", "notifications", "scenario_runs", "audit_log",
  "paypal_resource_owner", "sessions", "magic_links", "users"
  TO cleared_purger;--> statement-breakpoint
GRANT INSERT ON TABLE "audit_log" TO cleared_purger;--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE "workspaces", "review_hold_pool" TO cleared_purger;--> statement-breakpoint
-- Deletes every row of one demo workspace (children first), detaches its review-hold pool rows (ADR 0019),
-- marks it purged and writes one platform-level, counts-only audit row. Refuses a seller workspace and the
-- pool workspace. The workspace row stays (kind, dates, purged_at: no content), so the audit row, the
-- late-webhook guard (`acceptsMirror`) and the demo caps keep their reference. Returns the counts.
CREATE OR REPLACE FUNCTION purge_workspace(p_workspace uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws_kind text;
  t text;
  n bigint;
  counts jsonb := '{}'::jsonb;
  tables text[] := ARRAY[
    'explanations', 'approvals', 'executions', 'dispute_drafts', 'client_acks', 'extracted_facts',
    'scope_checks', 'evidence_items', 'proposed_actions', 'proof_packs', 'holds', 'disputes', 'payments',
    'blobs', 'agent_steps', 'agent_runs', 'notifications', 'scenario_runs', 'audit_log',
    'paypal_resource_owner', 'sessions', 'magic_links', 'users'];
BEGIN
  SELECT kind::text INTO ws_kind FROM workspaces WHERE id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'purge_workspace: no workspace %', p_workspace USING ERRCODE = 'no_data_found';
  END IF;
  IF ws_kind <> 'demo' THEN
    RAISE EXCEPTION 'purge_workspace: % is a % workspace', p_workspace, ws_kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM review_hold_pool WHERE pool_workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'purge_workspace: % is the review-hold pool workspace', p_workspace
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE review_hold_pool SET assigned_workspace_id = NULL, assigned_at = NULL, updated_at = now()
    WHERE assigned_workspace_id = p_workspace;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('review_hold_pool_detached', n);
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DELETE FROM %I WHERE workspace_id = $1', t) USING p_workspace;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;
  UPDATE workspaces SET purged_at = coalesce(purged_at, now()) WHERE id = p_workspace;
  INSERT INTO audit_log (workspace_id, actor, action, detail)
    VALUES (NULL, 'system', 'retention.purged', jsonb_build_object('workspaceId', p_workspace, 'counts', counts));
  RETURN counts;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_workspace(uuid) FROM PUBLIC;--> statement-breakpoint
-- ALTER … OWNER needs SET on the new owner and CREATE on the schema for it. On Render the migrating role is
-- a CREATEROLE non-superuser that holds only ADMIN on a role it created (PG 16+): it takes SET for these
-- statements and drops it, and the CREATE grant is revoked straight after. The app role (the migrating
-- role) gets EXECUTE from the new owner; nothing else does.
GRANT USAGE, CREATE ON SCHEMA public TO cleared_purger;--> statement-breakpoint
DO $$
DECLARE
  had_set boolean := pg_has_role(current_user, 'cleared_purger', 'SET');
  app text := current_user;
BEGIN
  IF NOT had_set THEN
    EXECUTE format('GRANT cleared_purger TO %I WITH INHERIT FALSE, SET TRUE', app);
  END IF;
  ALTER FUNCTION purge_workspace(uuid) OWNER TO cleared_purger;
  SET LOCAL ROLE cleared_purger;
  EXECUTE format('GRANT EXECUTE ON FUNCTION purge_workspace(uuid) TO %I', app);
  RESET ROLE;
  IF NOT had_set THEN
    EXECUTE format('REVOKE cleared_purger FROM %I', app);
  END IF;
END
$$;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM cleared_purger;
