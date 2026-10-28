---
title: "M4-07 · Judging runbook Dec 1–15 + retention purge job"
milestone: "M4 · Trust & Global"
labels: ["infra", "docs", "backend"]
blocked_by: ["M3-GATE"]
estimate: "2h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-30]
---

## Context

Judging runs 2026-12-01 14:00 PT → 2026-12-15 08:00 PT, and the project must stay testable throughout (PROJECT.md §1; a non-functional demo disqualifies). The owner needs a short, repeatable daily routine and a playbook per failure. Demo data is synthetic but still retained only as long as needed: demo workspaces don't expire before 2026-12-16 and are purged on 2026-12-22 (B6 #18, #20; ADR 0007; architecture §5). Rubric: Stage One, Technological Implementation (operability).

## Scope

- **Runbook** `docs/operations/judging-runbook.md`:
  - **Daily checks, ≤ 10 min, each with its command or link:**
    - the synthetic judge-path result from the reconcile job (M3-09)
    - `/healthz` and `/readyz`
    - Sentry new issues
    - Render service health and deploy status
    - OpenAI spend today vs `LLM_DAILY_CAP_USD`
    - demo workspace counts vs `DEMO_WORKSPACES_GLOBAL_MAX`
    - webhook lag (last `webhook_events.received_at`)
    - the DLQ count
    - nightly eval green (M4-02)
    - PayPal sandbox status
  - **Playbooks**, each with symptom, check, action and rollback:
    - OpenAI outage or cap reached: the degraded mode is already built; a cap raise needs the owner
    - PayPal sandbox down or changed behaviour
    - webhook registration lost: re-run the idempotent setup script
    - global workspace cap reached: purge `loadtest`/abandoned workspaces; a cap raise needs the owner
    - a bad deploy: Render rollback to the previous deploy
    - Postgres near its storage limit
    - the Bryntum trial expires: switch `CashCalendar` to FullCalendar
    - a judge-reported bug
    - the kill switch (`AGENT_KILL_SWITCH`)
  - **Change freeze:** from 2026-12-01, deploys are fixes only, each one followed by the synthetic check
  - **Thresholds** from the M4-06 load report and the residual risks from M4-05
- **Retention policy in code** (`packages/core/src/retention.ts`, pure):
  - demo `expires_at` = 2026-12-16T00:00Z for demo workspaces created before then; a workspace created later gets created_at + 7 days
  - purge when `now ≥ expires_at + 6 days` (so 2026-12-22 for the judging cohort)
  - seller workspaces are never purged automatically
- **Purge job** in `apps/worker`: a daily pg-boss schedule `retention.purge`. In one transaction per workspace, it deletes the workspace's evidence, blobs, packs, checks, acknowledgements, holds, explanations, disputes and drafts, actions, approvals and executions, agent runs and steps, notifications, sessions and `paypal_resource_owner` rows
  - `audit_log` stays append-only for the app role. The purge calls a `SECURITY DEFINER` function `purge_workspace(uuid)`, owned by a separate role, so the app role still has no DELETE grant. This is recorded in a new ADR
  - it writes a platform-level audit row (counts only, no content)
  - it is idempotent and safe to re-run
  - `--dry-run` prints the counts
- **Scope note:** PayPal sandbox resources can't be deleted; this is noted in the runbook
- An "Uses sample data; demo workspaces are deleted on 2026-12-22" banner on demo workspaces, if M1-05 has not already added one (EN/HI keys via M4-03's files)

## Out of scope

- The synthetic judge-path check itself (M3-09)
- Security tests of the purge function's grants beyond this job's own tests (M4-05 covers the audit grants)
- Making the repo public or the submission (M5-SUBMIT)

## Acceptance Criteria

- [ ] Unit tests for `retention.ts`: a workspace created 2026-11-20 → expires 2026-12-16, purge 2026-12-22; created 2026-12-20 → expires 2026-12-27; a seller workspace is never purged
- [ ] An integration test on a seeded DB with a fake clock at 2026-12-22T00:01Z: the purge removes every row of expired demo workspaces across all listed tables, leaves seller and non-expired demo workspaces untouched, and writes one counts-only audit row per workspace
- [ ] A second run purges 0 (idempotent); `--dry-run` changes nothing (row counts equal before and after)
- [ ] The app DB role still fails `DELETE FROM audit_log` (test)
- [ ] The ADR exists, and `docs/operations/judging-runbook.md` has every daily check and playbook listed in Scope (`pnpm runbook:check` verifies the headings and that each linked command exists in `package.json`)

## Deliverables

- `docs/operations/judging-runbook.md`, `docs/adr/0016-demo-retention-purge.md`
- `packages/core/src/retention.ts` + tests
- `apps/worker/src/jobs/retention-purge.ts` + tests; a migration for `purge_workspace` and its role (hot file `packages/db/schema/*`)
- `scripts/check-runbook.ts`

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
make down && make up && pnpm db:migrate && pnpm db:seed
pnpm --filter @cleared/core test -- retention
pnpm --filter @cleared/worker test -- retention-purge
FAKE_NOW=2026-12-22T00:01:00Z pnpm --filter @cleared/worker exec tsx src/jobs/retention-purge.ts --dry-run | tee "$TMPDIR/purge-dry.txt"
pnpm runbook:check
```

## Handoff

- **M4-GATE** runs the purge dry run on the clean seeded stack
- **M5-SUBMIT** points the owner to the runbook for Dec 1–15
- **M5-01** states the retention dates in the README ("demo data deleted 2026-12-22")
