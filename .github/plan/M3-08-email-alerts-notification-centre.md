---
title: "M3-08 · Email alerts + in-app notification centre"
milestone: "M3 · Holds & Cash"
labels: [backend, frontend]
blocked_by: [M2-GATE]
estimate: "4h"
resources: []
needs: []
---

## Context
Dispute deadlines are fatal. An unanswered case auto-closes for the buyer, and an absent seller never sees an in-app nudge (B6 #7). The SLO is **0 missed deadlines**, with alerts at T-72 h and T-24 h (architecture §9). ADR 0015: Resend email for deadlines and new holds/disputes, plus an in-app notification centre. This serves **Impact** (no lost cases) and **Design** (prevention, "no warning before it happens").

## Scope
- `packages/core/src/notifications/`: rules for `hold_opened`, `dispute_opened`, `deadline_t72`, `deadline_t24`, plus `completed_reminder` (Completed + 7 days, from M3-04). Templates are EN/HI, plain text + simple HTML, with no tracking pixels. The dedupe key is (workspace, kind, ref_id, threshold).
- Consumers:
  - `hold.opened` and `dispute.opened` outbox consumers insert `notifications` rows (idempotent on the dedupe key)
  - a pg-boss scheduled job every 15 min selects open disputes whose `seller_response_due_date − now` crosses 72 h or 24 h, and inserts the deadline notifications once (a late run still sends, with the true remaining time)
- Email delivery:
  - a `send_email` job per notification, via the Resend SDK on the shared HTTP client (10 s timeout; retries only on 5xx/429/timeout)
  - only for workspaces with a seller email (demo workspaces are in-app only)
  - only to addresses in `EMAIL_RECIPIENT_ALLOWLIST` until the owner confirms a verified domain (a guard in code; a blocked send is logged, not an error)
  - `sent_via`/`sent_at` are recorded
- Email down → the notification stays in-app, and the failure goes to Sentry and the DLQ after retries.
- In-app centre:
  - a header bell with the unread count (SWR, 5 s)
  - a panel/page listing notifications with links to the hold or dispute
  - mark read / mark all read
  - the `GET/PATCH /api/notifications` API is workspace-scoped and zod-validated
  - empty, loading and error states
- Email content: amount, reason or deadline in the seller tz, and a link to `APP_BASE_URL`. It never carries evidence text or buyer messages.

## Out of scope
- Magic-link email: M1-05
- Reconcile/SLO alerting to the operator: M3-09
- WhatsApp/SMS: future
- HI copy review and formatting: M4-03

## Acceptance Criteria
- [ ] Unit: the threshold logic fires T-72 and T-24 exactly once each for a dispute due in 80 h, across simulated 15-min ticks (time-injected test)
- [ ] Replaying the M0-05 dispute fixture produces one `dispute_opened` notification; replaying again adds none
- [ ] A recipient not in `EMAIL_RECIPIENT_ALLOWLIST` is never sent (test asserts 0 Resend calls)
- [ ] A Resend 500 (msw replay) retries with backoff, then lands in the DLQ; the in-app notification still exists
- [ ] Live: one T-24 email to an allowed test address arrives (the Resend message id is recorded in the PR, no address)
- [ ] Playwright: bell count, list, mark read; axe clean (WCAG 2.2 AA); 360 px; `ui-reviewer` passes

## Deliverables
- `packages/core/src/notifications/{rules.ts,templates/*.ts}` (+ tests)
- `packages/adapters/src/email/resend.ts`, `apps/worker/src/jobs/{deadline-alerts.ts,send-email.ts}`, `apps/worker/src/consumers/notifications.ts`
- `apps/web/app/api/notifications/**`, `apps/web/components/notifications/**`, `apps/web/e2e/notifications.spec.ts`
- `.env.example`: add `EMAIL_RECIPIENT_ALLOWLIST` (hot file; coordinate)

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- notifications
pnpm --filter ./apps/worker test -- deadline-alerts send-email notifications
pnpm --filter ./apps/web exec playwright test e2e/notifications.spec.ts --reporter=line > "$TMPDIR/m3-08-e2e.txt"; tail -5 "$TMPDIR/m3-08-e2e.txt"
grep -n "EMAIL_RECIPIENT_ALLOWLIST" .env.example
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-09 counts missed deadlines from `notifications` + disputes for the SLO
- M3-11 shows the bell during the dispute scene
- M4-03 translates the templates
- M4-07's runbook lists the email limits
