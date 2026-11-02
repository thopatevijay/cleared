# 0013. Observability baseline

- Status: accepted
- Date: 2026-10-28

## Context

The core flow has SLOs (webhook → hold visible, approved action → PayPal 2xx, zero missed deadlines) and runs unattended through judging.

## Decision

pino JSON logs with a correlation ID through request → job → PayPal `debug_id`; agent runs and steps in the database (tokens, cost, latency); Sentry (free tier) for errors; SLO checks and a daily synthetic run of the judge path inside the reconcile job, raising Sentry alerts; `/healthz` and `/readyz`.

## Alternatives considered

An OpenTelemetry collector and backend (heavy for two services; trigger: a third service).

## Consequences

Enough to run the judging window unattended. Reversal cost: low.

## Addendum 2026-11-02 (M3-09): the synthetic workspace is purged, append-only rows included

**Context.** The daily synthetic judge path writes a real workspace's worth of rows (payment, pack, evidence, dispute, actions, audit log) in a demo workspace flagged `workspaces.synthetic`. `audit_log`, `evidence_items` and `scope_checks` are append-only (triggers, migration 0002; grants, 0006). Keeping every run's rows would add one synthetic workspace a day to the database through judging.

**Decision.** After each run, `purgeSyntheticWorkspace` deletes the workspace's rows, the append-only tables included, in one transaction. Two things are kept: the workspace row (flagged synthetic and expired), and its `agent_runs` / `agent_steps`. The global LLM day cap counts those, and the run records its spend in `ops_checks.detail.aiCostUsd`. The purge works like this:
- it locks the workspace row (`FOR UPDATE`) and refuses unless `synthetic = true` (an unknown id is refused too)
- it checks that the role owns the three append-only tables (or is a superuser) before changing anything, and refuses with `PurgeNotPermittedError` otherwise
- it disables each append-only trigger and grants DELETE (only where missing) inside the transaction, deletes, then revokes and re-enables before the commit, under `lock_timeout = 5s`

This is the pattern migration 0006 prescribes for a purge. The deleted audit rows describe only the synthetic run's own actions (actor `system` / the synthetic approval), with no seller and no personal data. The run's evidence for operators is its `ops_checks` rows, which are kept.

**If the purge can't run** (role not the owner, lock timeout), the run keeps its result. The workspace stays flagged synthetic, so it stays out of the demo caps and the SLO samples, and it expires two hours after it was created. The worker logs an error and raises one Sentry warning, `synthetic workspace purge failed`. The retention purge (M4-07) then removes it with the demo workspaces.

**Not verified in production.** The production role's ownership of the append-only tables couldn't be read on 2026-11-02: the read-only helper's IP isn't on the Render database allow list. Migrations 0002 and 0006 state that the app connects as the table owner on Render. Confirm before the first scheduled run: `select tablename, tableowner = current_user from pg_tables where tablename in ('audit_log','evidence_items','scope_checks')`.

**Alternative considered.** Keep the rows, flagged synthetic, until the M4-07 retention purge. This needs no guard lifting in production, but it adds about 45 synthetic workspaces of rows by 2026-12-15. It is the fallback above.

**Review.** M4-05 (STRIDE) reviews lifting the append-only guard in production (BL-01).
