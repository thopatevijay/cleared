---
title: "M5-PERF · Cut idle Postgres load (prod DB CPU pinned at 100 % on 0.1 CPU)"
milestone: "M5 · Submission"
labels: ["backend", "infra"]
blocked_by: []
estimate: "3h"
resources: []
needs: []
---

**Owner decision 2026-11-04:** option (a) of BL-01 comment 6629874892, made a ticket and run now.

## Context

Production Postgres (`cleared-db`, basic-256mb, **0.1 CPU**) sits at about 95–100 % CPU for days, idle or under load (Render metrics, read 2026-11-04). Web peaked at only about 28 % of 0.5 CPU during the M4-06 launch test. Locally the same routes run with a server p95 of 11–36 ms; production gives 818–1,413 ms (#50, #142). The database is the bottleneck. Sources of constant load include pg-boss polling of every queue (2 s, `burstWhenReadyExceeds: 1`), the reconcile poll (15 min, 72 h window), ops/SLO checks, and a 30 s re-sync loop per open dispute (seen in the worker logs for PP-R-BZF-10196342).

## Scope

- **Measure first, locally, on a production-shaped dataset:** the steady-state queries per minute at idle, by source (`pg_stat_statements` or the pg-boss/app query log). Record them before and after.
- **Reduce idle load without losing correctness:** a longer poll interval for low-priority queues; fewer or merged queues where safe; back off the per-dispute re-sync when the state has been unchanged for a while (keep webhooks as the primary signal and re-fetch on every webhook, per CLAUDE.md); only cheap indexed queries in periodic jobs.
- **Keep every SLO and behaviour test green:** hold visibility, dispute mirror, the reconcile catching a missed webhook, the outbox and idempotency.
- **No Render plan change, no `render.yaml` plan edits.**

## Out of scope

- A Render plan change or any `render.yaml` edit (the Postgres upgrade is the owner's fallback)
- Narrowing the reconcile's 72 h window (BL-01 6603617791) unless it is option (a) and small

## Acceptance Criteria

- [ ] Local idle DB load measured before and after (queries/min and the top queries), with at least a 5× reduction in idle query rate, or the honest measured number if less
- [ ] No behaviour regression: `landing-checks.sh` green; the reconcile still catches a missed webhook (test); dispute and capture state still mirror PayPal
- [ ] After deploy: the manager reads Render `cleared-db` CPU and web route latency and records them in `docs/evidence/load-report.md`

## Deliverables

- The idle-load change in the worker (pg-boss work options, scenario poll back-off) with tests
- Before/after measurement in `docs/evidence/load-report.md`

## Validation Gate

```bash
./scripts/landing-checks.sh
```

## Handoff → M5-01

M5-01 (README) cites the measured result. If DB CPU stays pinned, the Postgres plan upgrade (owner purchase) is the fallback before judging (Dec 1).
