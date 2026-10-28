---
title: "M3-09 · Reconcile poll + SLO checks + daily synthetic judge-path check"
milestone: "M3 · Holds & Cash"
labels: [infra, backend, critical]
blocked_by: [M2-GATE]
estimate: "4h"
resources: [PAYPAL_SANDBOX]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-21, P-24, P-30, P-46]
---

## Context
Webhooks are app-scoped, unordered and can be lost (B6 #5). Executions can end `unknown` (B6 #6). The demo must stay testable unattended until 2026-12-15 (B6 #18). Architecture §6 and §9 and ADR 0013 fold three things into one reconcile job:
- a **poll every 15 min** of known open items
- the **SLO checks**
- a **daily synthetic run of the judge path**, alerting through Sentry

This keeps the hosted demo functional for judges (Stage One) and backs **Tech** reliability claims with measurements.

## Scope
- pg-boss schedule `reconcile` every 15 min (singleton, so an overlapping run is skipped). Each item is its own idempotent sub-job and goes through the shared HTTP client (PayPal 10 s timeout, retries only on timeout/5xx/429, Retry-After). It covers:
  - **Payments:** every owned capture that is `PENDING`, or that changed in the last 72 h → capture GET → mirror with `source = poll`, through the same consumer path as webhooks (M3-01). The state change and its outbox row are one transaction; unchanged captures write nothing.
  - **Disputes:** every owned dispute not `RESOLVED` → dispute GET → mirror status, stage, due date and HATEOAS links (M2-06 path).
  - **Executions in `unknown`:** resolve via the action's reconcile function (dispute status/evidence read-back from M2-08, order trackers from M3-03, trackers-batch read-back from M3-04) → `succeeded`/`failed`, with an audit entry.
  - Unowned resources are never fetched or mirrored.
- **SLO checks** (after each poll), results stored in `ops_checks` (new table: run_at, check, value, target, pass), each with a Sentry alert on breach:
  - webhook received → hold visible p99 < 2 min (from `webhook_events.received_at` vs `holds.opened_at`)
  - approved → PayPal 2xx < 5 min (from approvals vs executions)
  - missed dispute deadlines = 0 (an open dispute past `seller_response_due_date` with no filed action)
  - the last synthetic pass is < 26 h old
- **Daily synthetic judge path** (once per UTC day, plus manual trigger `pnpm --filter ./apps/worker run synthetic`):
  - create a demo workspace flagged `synthetic` (excluded from the caps and the workspace list)
  - run the M2-10 scenario runner: card capture with `custom_id` → chargeback → wait ≤ 5 min for `PENDING/BUYER_COMPLAINT` → pack from canned synthetic evidence (served by the AI content-hash cache, ~$0) → evidence filed → labelled sandbox decision → released to `COMPLETED`, ≤ 30 min overall
  - each step is timed into `ops_checks`; a failure alerts Sentry with the failing step
  - the workspace is purged afterwards
- `/readyz` includes "last reconcile < 30 min ago".

## Out of scope
- Webhook ingest itself: M1-04
- Dispute and action mirroring logic: M2-06, M2-08 (reused here)
- Email to sellers: M3-08
- Load test: M4-06
- Judging runbook: M4-07

## Acceptance Criteria
- [ ] Fixture replay: a capture fixture `PENDING` → `COMPLETED` delivered only by poll (no webhook) releases the hold and writes one outbox row; a second identical poll writes nothing
- [ ] A foreign or unowned capture in the fixture set is never fetched (msw asserts no request)
- [ ] An `unknown` execution with a read-back fixture showing the evidence accepted becomes `succeeded`, with an audit row
- [ ] SLO unit tests: each check passes and breaches on crafted rows; a breach calls the Sentry adapter (spy)
- [ ] Overlapping schedule ticks run one reconcile (singleton test)
- [ ] Live (PAYPAL_SANDBOX): one synthetic judge-path run passes end to end on the local stack against the sandbox; per-step timings are in `ops_checks` and the PR
- [ ] `/readyz` returns 503 when the last reconcile is stale (test)

## Deliverables
- `apps/worker/src/jobs/{reconcile.ts,slo-checks.ts,synthetic-judge-path.ts}` (+ tests)
- `packages/core/src/ops/slo.ts` (+ tests)
- `packages/db/` migration for `ops_checks` and the `workspaces.synthetic` flag (hot file; coordinate)
- `apps/worker/package.json` script `synthetic`

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- slo
pnpm --filter ./apps/worker test -- reconcile slo-checks synthetic
make up && pnpm --filter ./packages/db run migrate
pnpm --filter ./apps/worker run synthetic > "$TMPDIR/m3-09-synthetic.txt" 2>&1; tail -15 "$TMPDIR/m3-09-synthetic.txt"
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-11 and M3-GATE rely on the poll as the webhook backstop on production
- M4-06 load-tests alongside the reconcile
- M4-07's runbook reads `ops_checks` and the Sentry alerts for Dec 1–15
- M4-05 reviews the synthetic workspace exclusion from the caps
