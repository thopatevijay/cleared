---
title: "M3-GATE · Holds & Cash gate: the storyboard runs for real on production"
milestone: "M3 · Holds & Cash"
labels: [gate, critical]
blocked_by: [M3-01, M3-02, M3-03, M3-04, M3-05, M3-06, M3-07, M3-08, M3-09, M3-10, M3-11]
estimate: "1h"
resources: [DEPLOY, PAYPAL_SANDBOX, OPENAI]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14, P-21, P-24, P-28, P-29, P-35, P-46, P-52]
---

## Context
PROJECT.md §8: "M3-GATE: the full storyboard runs for real on production." This is the last point where a feature gap can be fixed before M4 hardening. It proves the hosted demo is functional (Stage One), that real PayPal state changes appear on camera (**Presentation**), and that holds, explanations, the calendar and alerts work (**Impact**, **Design**). It is a hard stop: nothing is deferred to pass it.

## Scope
- **Clean state, never a warm environment:**
  - locally: `make down`, then a fresh `make up`, migrations from zero, seed
  - production: a fresh deploy of the main HEAD, and a **new** recording workspace
  - a new video-pool review-hold payment, approved by the owner 24 h before (M3-10)
  - a new chargeback about 20 min before (M2-10)
- **Local checks:** `./scripts/landing-checks.sh` (full), the fixture-replay suites for every M3 ticket, and `python3 scripts/check-plan.py`.
- **Production demo-level checks** (the full §2 storyboard, 0:20–2:15, as in M3-11):
  1. payment → evidence → scope check with verbatim citations → client acknowledgement accepted → scope snapshot downloaded
  2. a real `PENDING/PENDING_REVIEW` hold, explained in HI, with an estimated release and its cited source; sample-scenario explainers are badged
  3. route advice + tier badge on a goods order; an approved tracking action returns 201
  4. the guided Completed step plus the secondary trackers-batch record, labelled "effect on release unconfirmed"
  5. chargeback → `BUYER_COMPLAINT` hold → alert (bell + email to an allowed address) → draft → seller approval → evidence 2xx → labelled sandbox decision → `RESOLVED_WITH_PAYOUT` → capture `COMPLETED`, shown in the UI
  6. the cash calendar shows the releases and deadlines on the engine chosen by the 2026-11-04 licence decision (recorded in `apps/web/config/cash-calendar.ts`)
  7. the audit log shows every proposal, approval and execution
  8. the reconcile poll ran in the last 30 min (`/readyz`); the SLO checks pass; the synthetic judge path passed in the last 26 h
  9. a judge-path run from "Try as demo seller" in a private window, with no keys
- Record the results in `docs/evidence/m3-gate.md`.

## Out of scope
- Evals, Hindi UI chrome, a11y/perf budgets, security, load test: M4
- Video: M5-02

## Acceptance Criteria
- [ ] The local clean-state run is green: landing checks (full) and `check-plan.py` pass
- [ ] Production checks 1–9 pass; `docs/evidence/m3-gate.md` records the sandbox IDs, `debug_id`s, timings and the state-change source for each
- [ ] The production Playwright storyboard passes for the automated steps
- [ ] The latest `ops_checks` rows all show `pass = true`
- [ ] No secrets in the evidence files (`check-no-secrets.sh`)

## Deliverables
- `docs/evidence/m3-gate.md`

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
make down && make up
pnpm --filter ./packages/db run migrate && pnpm --filter ./packages/db run seed
./scripts/landing-checks.sh > "$TMPDIR/m3-gate-landing.txt" 2>&1; tail -5 "$TMPDIR/m3-gate-landing.txt"
python3 scripts/check-plan.py
test -n "$E2E_BASE_URL" && curl -fsS "$E2E_BASE_URL/readyz"
pnpm --filter ./apps/web exec playwright test e2e/storyboard.spec.ts --reporter=line > "$TMPDIR/m3-gate-storyboard.txt" 2>&1; tail -10 "$TMPDIR/m3-gate-storyboard.txt"
./scripts/check-no-secrets.sh
```

## Handoff
- M4-01…M4-07 start from a demo that works on production
- M5-02 records against the same staging steps
- The post-gate sweep worker triages the BL-01 entries from M3-11
