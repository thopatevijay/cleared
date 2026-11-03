# 0020. Demo retention purge through a SECURITY DEFINER function

- Status: accepted
- Date: 2026-11-03
- Ticket: M4-07 (the ticket names this file `0016-…`; 0016 to 0019 were taken by M3, so it is 0020)

## Context

Demo data is synthetic, but it is still kept only as long as judging needs it (ADR 0007, architecture §5):
demo workspaces expire on 2026-12-16 and are purged on 2026-12-22. A purge has to delete rows from the
append-only tables (`audit_log`, `evidence_items`, `scope_checks`). Two guards stop that today:

- the statement-level trigger `cleared_append_only()` (migrations 0002, 0009) raises for every role,
  superusers included (BL-01 6527917509);
- migration 0006 revoked UPDATE, DELETE and TRUNCATE on `audit_log` from PUBLIC and from the app role,
  which on Render is the table owner (BL-01 6537331419).

The synthetic judge path (M3-09, ADR 0013 addendum) lifts both guards inside its own transaction, which
works only because the app role owns the tables. Doing the same for every demo workspace would make
the app role's normal path able to delete audit rows. Production facts, read on 2026-11-03 with the
read-only helper: the app role `cleared` owns the tables and the `public` schema, has CREATEROLE, is not a
superuser, and runs PostgreSQL 18.6.

## Decision

- **One SECURITY DEFINER function**, `purge_workspace(uuid) returns jsonb` (migration 0019), owned by a
  new `NOLOGIN NOINHERIT` role **`cleared_purger`**. `search_path` is pinned to `public, pg_temp`.
  EXECUTE is revoked from PUBLIC and granted to the app role only.
- **The trigger lets one role DELETE.** `cleared_append_only()` returns early when
  `TG_OP = 'DELETE' AND current_user = 'cleared_purger'`, which is true only inside the definer
  function. UPDATE and TRUNCATE still raise for every role. The app role keeps no DELETE grant on
  `audit_log`, so `DELETE FROM audit_log` as the app role still fails (the 0006 grant on Render, the
  trigger locally and in CI, where the app connects as a superuser).
- **`cleared_purger` holds only what the purge needs:** SELECT and DELETE on the 23 workspace tables,
  INSERT on `audit_log`, SELECT and UPDATE on `workspaces` and `review_hold_pool`. It can't log in.
- **What the function does, in the caller's transaction:**
  1. it locks the workspace row `FOR UPDATE`;
  2. it refuses a `seller` workspace and the review-hold pool workspace (ADR 0019);
  3. it detaches `review_hold_pool` rows assigned to the workspace (`assigned_workspace_id` set to null).
     They can't be assigned again: assignment needs the pool's own owner row, and the transferred owner
     rows go with the workspace;
  4. it deletes the workspace's rows, children first: explanations, approvals, executions, drafts,
     acknowledgements, facts, scope checks, evidence, actions, packs, holds, disputes, payments, blobs,
     agent steps and runs, notifications, scenario runs, audit rows, `paypal_resource_owner`, sessions,
     magic links and users;
  5. it sets `workspaces.purged_at`;
  6. it writes one **platform-level** audit row (`workspace_id` null, actor `system`, action
     `retention.purged`, `detail = {workspaceId, counts}`: counts only, no content).
- **The workspace row stays**, holding only kind, dates and `purged_at`. It keeps the audit row's
  reference, and `acceptsMirror` refuses any workspace with `purged_at` set. A capture or dispute sync
  that races the purge waits on the row lock, then quarantines (`workspace_purged`) instead of
  re-creating rows. The synthetic-only guard of BL-01 6594517545 now covers purged demo workspaces too.
- **The policy lives in core** (`packages/core/src/retention.ts`, pure). A demo workspace created before
  2026-12-16 expires then; one created later lives 7 days. The purge is due at `expires_at + 6 days`.
  Seller workspaces are never purged automatically.
- **The job.** The worker runs `retention.purge` daily at 04:00 UTC: a singleton queue, never retried,
  one transaction per workspace. It runs on demand too:
  `pnpm --filter @cleared/worker exec tsx src/jobs/retention-purge.ts [--dry-run] [--workspace <id>]`.
  `--dry-run` only counts. A purged workspace is never a candidate again, so a re-run purges 0.
- **Migration on Render.** `ALTER FUNCTION … OWNER TO cleared_purger` needs SET on the new role and
  CREATE on the schema. The creator of a role holds only ADMIN on it in PostgreSQL 16 and later, so the
  migration grants itself `SET` for the ownership change and the EXECUTE grant, then revokes it. It also
  grants `CREATE ON SCHEMA public` and revokes it straight after. This path was rehearsed locally as a
  non-superuser CREATEROLE schema owner, the same shape as production.

## Consequences

- The app role's ordinary queries can't delete an audit row: neither a bug nor an injected `DELETE` can.
  The one way to delete audit rows is the definer function, and it purges whole demo workspaces only.
- **Not covered:** a fully compromised app role. It owns the tables and holds ADMIN on `cleared_purger`,
  so it could grant itself membership, or disable the trigger on a table it owns (as the synthetic purge
  does by design, threat model A-2). The definer function narrows the normal path; it isn't a boundary
  against the owner.
- The function doesn't check the clock. Which workspaces are due is the job's decision (core policy),
  so tests and a rehearsal can use `FAKE_NOW`. A misuse could purge a demo workspace early. Its data is
  synthetic and the audit row records the purge.
- **Scope:** PayPal sandbox resources (orders, captures, disputes, evidence files) can't be deleted
  through PayPal's API. The purge removes only Cleared's copies, and the runbook says so.
- The synthetic purge (M3-09) is unchanged. Its fallback, a synthetic workspace left flagged and
  expired, is now a retention candidate: it is purged 6 days after its stored expiry.
