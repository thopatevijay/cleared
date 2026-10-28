---
title: "M1-GATE · Walking Skeleton gate"
milestone: "M1 · Walking Skeleton"
labels: [gate]
blocked_by: [M1-01, M1-02, M1-03, M1-04, M1-05, M1-06, M1-07, M1-08]
estimate: "1h"
resources: [PAYPAL_SANDBOX]
needs: []
---

## Context
M1's promise (PROJECT.md §8): **a webhook-driven payment is visible on the deployed dashboard, from a clean stack**. This is the first time the functional hosted demo the rules require works for an anonymous judge, and everything in M2 builds on it. The gate is a hard stop: no feature is deferred to pass it. `PAYPAL_SANDBOX` is claimed because the gate makes a live sandbox payment and receives its real webhook.

## Scope
- **Clean local state:** `make reset` (drops the volume, up, migrate), then seed. Then run the full test suite and landing checks on `main` at the gate commit
- **Clean deployed state:**
  - the Render services run the gate commit from `main` (auto-deploy from main; the deploy log shows `preDeployCommand` migrations succeeded)
  - a **fresh demo workspace** is created through the UI, so no earlier data is reused
- **Demo-level checks:**
  1. The landing page explains itself and offers "Try as demo seller"
  2. A demo workspace opens with the empty state
  3. "Create a sandbox test payment" makes a real card capture with `custom_id = workspace_id`
  4. PayPal's real `PAYMENT.CAPTURE.COMPLETED` webhook is self-verified, stored once and synced
  5. The payment row (COMPLETED, via webhook) appears within 2 min
  6. A second demo workspace can't see it
  7. Switching to HI renders the screen in Hindi
  8. `/healthz` and `/readyz` are green
  9. The webhook's correlation ID can be followed in the Render logs from ingest to the PayPal `debug_id`
- Record the measured webhook → visible time and the ack time, and post the gate report on the M1-GATE issue

## Out of scope
- Disputes, evidence and AI → M2-GATE
- Holds and the cash calendar → M3-GATE
- Load or eval numbers → M4-GATE

## Acceptance Criteria
- [ ] From a clean local stack, `pnpm -r test` and `./scripts/landing-checks.sh` (full) pass
- [ ] `python3 scripts/check-plan.py` passes
- [ ] On the deployed URL, `skeleton.spec.ts` (M1-07) passes for a fresh demo workspace and prints `webhook_to_visible_ms` < 120000
- [ ] The deployed `webhook_events` row for that delivery has `verified=true` and `status='processed'`, and exactly one row exists for its `event_id` (the query in `docs/runbook/observability.md`, run in the Render Postgres shell; output pasted in the report)
- [ ] `curl $RENDER_WEB_URL/readyz` → 200 with `db`, `queue` and `worker` all true
- [ ] A second, fresh demo context sees an empty list (part of the spec)
- [ ] No Sentry errors from the gate run (warnings allowed); quarantine count 0
- [ ] The gate report (times, commit SHA, test totals, links to logs under `$TMPDIR`) is posted on the issue

## Deliverables
- The gate report comment on the M1-GATE GitHub issue (from `$TMPDIR/m1-gate-report.md`)
- No code changes. A failure opens a fix on the owning M1 ticket's area, then the whole gate reruns from clean

## Validation Gate
```bash
git switch main && git pull --ff-only
pnpm install --frozen-lockfile && make reset && pnpm --filter @cleared/db run seed
python3 scripts/check-plan.py
pnpm -r test 2>&1 | tee "$TMPDIR/m1-gate-tests.log"
./scripts/landing-checks.sh 2>&1 | tee "$TMPDIR/m1-gate-landing.log"
# deployed: Render auto-deployed this commit from main
RENDER_WEB_URL=$(grep -E "^RENDER_WEB_URL=" .env.example | cut -d= -f2-); test -n "$RENDER_WEB_URL"
curl -fsS "$RENDER_WEB_URL/healthz" && curl -fsS "$RENDER_WEB_URL/readyz" | tee "$TMPDIR/m1-gate-ready.json"
grep -q '"db":true' "$TMPDIR/m1-gate-ready.json" && grep -q '"worker":true' "$TMPDIR/m1-gate-ready.json"
E2E_BASE_URL="$RENDER_WEB_URL" pnpm --filter @cleared/web exec playwright test skeleton 2>&1 | tee "$TMPDIR/m1-gate-e2e.log"
ms=$(grep -oE "webhook_to_visible_ms=[0-9]+" "$TMPDIR/m1-gate-e2e.log" | cut -d= -f2); [ "$ms" -lt 120000 ]
{ echo "M1-GATE $(git rev-parse --short HEAD)"; echo "webhook_to_visible_ms=$ms"; tail -5 "$TMPDIR/m1-gate-tests.log"; } > "$TMPDIR/m1-gate-report.md"
```

## Handoff
M2 tickets (M2-01, M2-02, M2-06) start only after this gate passes. They rely on:
- the deployed web and worker
- the webhook route and capture sync
- the demo workspaces and caps
- the design system
- the correlation-ID logging

M2-06 adds dispute routing onto the stored webhook events, and M2-10 builds the judge scenario on the test-payment path.
