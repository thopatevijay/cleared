---
title: "M3-11 · Storyboard dry run on production (live)"
milestone: "M3 · Holds & Cash"
labels: [critical, owner]
blocked_by: [M3-01, M3-02, M3-03, M3-04, M3-05, M3-06, M3-07, M3-08, M3-09, M3-10]
estimate: "2h"
resources: [DEPLOY, PAYPAL_SANDBOX, OPENAI]
needs: []
---

## Context
**Presentation** is 20% of the score and depends on real sandbox state changes on camera. The demo must be functional on a hosted URL (Stage One). This ticket runs the PROJECT.md §2 storyboard **for real on production** (Render, Oregon), scene by scene. It finds every gap before M3-GATE and before the M5-02 recording, and times each scene against the < 3:00 cut.

## Scope
- **Staging, per §2:**
  - deploy main to Render (DEPLOY)
  - **24 h before:** the owner creates and approves a video-pool review-hold payment (M3-10) and assigns it to a fresh recording workspace
  - **about 20 min before:** create the pre-staged chargeback through the M2-10 runner on a $120 card capture in that workspace
- **Run each scene on the production URL** with synthetic personas only:
  1. **0:20–0:45:** the Bengaluru designer persona's card payment arrives; she pastes the client chat and uploads files; the AI scope check returns verdicts with verbatim citations (M2-04); a client acknowledgement link is accepted from a second browser (M3-06); the scope snapshot downloads (M3-07)
  2. **0:45–1:05:** the held-money inbox shows the real `PENDING_REVIEW` payment, explained in **Hindi** with the estimated release date and its source (M3-01/02); a goods order shows route advice and the tier badge (M3-03)
  3. **1:05–1:50:** the dispute lands, and the payment flips to `PENDING/BUYER_COMPLAINT`. The bell and email alert fire (M3-08). The agent drafts from the pack; the owner approves; evidence is filed (2xx `debug_id`). The labelled "Simulate PayPal's decision (sandbox only)" control runs. The outcome reads "Resolved: she keeps the $120 (PayPal covered the case)", and the hold releases to `COMPLETED` (UI updated by webhook or the M3-09 poll)
  4. **1:50–2:15:** the cash calendar shows the releases and deadlines (M3-05); the audit log shows every agent proposal and seller approval
  5. the guided Completed step (M3-04) is reachable on a service payment
- Record per scene: wall time, PayPal IDs (sandbox IDs only), screenshots, and whether the state change was webhook- or poll-driven.
- A Playwright script `apps/web/e2e/storyboard.spec.ts` automates the non-owner steps against `E2E_BASE_URL` (owner approval and the buyer browser stay manual). Its screenshots are written to `$TMPDIR`; the chosen ones are copied to `docs/evidence/`.
- Every defect found is filed in BL-01, or fixed in the owning M3 ticket's follow-up PR before M3-GATE. Scope is never cut.

## Out of scope
- The video recording and voice-over: M5-02
- The eval numbers slide: M4-02
- The UI-chrome Hindi pass: M4-03 (the AI explanation is already HI)
- Load and security: M4-06, M4-05

## Acceptance Criteria
- [ ] `docs/evidence/m3-storyboard-dry-run.md` lists every scene with: pass/fail, wall time, sandbox IDs, and the source of each state change; there are no secrets and no real personal data
- [ ] The `PENDING_REVIEW` hold is real (capture GET on production shows `PENDING` + `PENDING_REVIEW`) and is explained in HI, with a source link
- [ ] The dispute path reaches `RESOLVED` with `RESOLVED_WITH_PAYOUT`, and the $120 capture returns to `COMPLETED`, both visible in the UI
- [ ] The evidence filing and the tracking action each have a 2xx `debug_id` in `executions`
- [ ] `E2E_BASE_URL=<prod> pnpm --filter ./apps/web exec playwright test e2e/storyboard.spec.ts` passes for the automated steps
- [ ] The scene timings fit 0:20–2:15 of the §2 storyboard (or the deltas are listed for M5-02)
- [ ] Open defects are each filed with a ticket or BL-01 entry

## Deliverables
- `apps/web/e2e/storyboard.spec.ts`
- `docs/evidence/m3-storyboard-dry-run.md`, `docs/evidence/m3-storyboard-*.png`

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
test -n "$E2E_BASE_URL"
curl -fsS "$E2E_BASE_URL/readyz"
pnpm --filter ./apps/web exec playwright test e2e/storyboard.spec.ts --reporter=line > "$TMPDIR/m3-11-storyboard.txt" 2>&1; tail -10 "$TMPDIR/m3-11-storyboard.txt"
grep -c "| pass |" docs/evidence/m3-storyboard-dry-run.md
./scripts/check-no-secrets.sh
```

## Handoff
- M3-GATE repeats the run from a clean state
- M5-02 uses the timings and staging steps
- M5-01 and M5-03 reuse the screenshots
- M4-07 turns the staging steps into the judging runbook
