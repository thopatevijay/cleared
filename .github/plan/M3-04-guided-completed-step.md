---
title: "M3-04 · Guided Completed step + secondary trackers-batch record"
milestone: "M3 · Holds & Cash"
labels: [backend, frontend]
blocked_by: [M3-01]
estimate: "3h"
resources: [PAYPAL_SANDBOX]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14, P-21, P-46]
---

## Context
Service sellers (the primary users) have no tracking number. help129 says: "We'll release the hold 7 days after you confirm the order status as Completed." PayPal support confirmed the **web path**: "you can update the order status to 'Completed' in your Activity section". Support also said that API equivalence "is not available". The legacy `/v1/shipping/trackers-batch` `COMPLETED` call works in sandbox (M0-04) but is deprecated and its effect on release is unknown. Pillar P3 (approved actions) → **Tech**, **Design** (honest limits).

## Scope
- **Primary: guided web step** on service payments that are held or need a release. A short, numbered guide (EN/HI): open PayPal Activity → the payment → update the order status to Completed. It shows:
  - a link to the PayPal Activity page on the right host for `PAYPAL_ENV` (sandbox vs live)
  - the capture/transaction ID with a copy button
  - PayPal support's quote with its date
- The seller confirms "I marked it Completed in PayPal" (with a date, default now). This records an audit entry (actor seller) and sets the hold estimate to `service_completed`: confirmed date + 7 days, source help129, labelled estimated. The Hold moves on via the M3-01 state machine. Writing it and its outbox row is one transaction.
- **Secondary: API record.** ProposedAction `record_service_completed`, labelled **"Effect on release unconfirmed"**, with a disclosure quoting PayPal support. Payload: transaction (capture) id, `status: COMPLETED`, no tracking number, `carrier: OTHER`. The approval is bound to the payload hash (M2-08). Execution:
  - calls `POST /v1/shipping/trackers-batch` through our typed client (shared HTTP client + token provider), with ownership and kill-switch checks
  - writes executions + `debug_id` + the audit log
  - Unknown outcome → reconcile by reading the tracker back.
- The secondary action **never changes the estimate** on its own. Only the seller's web-step confirmation does.
- Copy never says the API call releases money.

## Out of scope
- Goods tracking: M3-03
- Calendar display of the date: M3-05
- Reminder emails for the step: M3-08
- Poll reconcile of `unknown`: M3-09

## Acceptance Criteria
- [ ] Unit: the web-step confirmation sets the estimate to confirmed date + 7 days with `estimate_source = service_completed` (help129 quote + url); the secondary execution leaves the estimate unchanged
- [ ] Fixture replay (M0-04 trackers-batch fixture): an approved `record_service_completed` executes, and the read-back status `COMPLETED` is stored; a hash-mismatched payload is refused
- [ ] Live (PAYPAL_SANDBOX): one `record_service_completed` on a Cleared-owned sandbox capture returns 200 and reads back `COMPLETED`; the `debug_id` is in the PR
- [ ] UI test: the secondary action always shows "Effect on release unconfirmed"; the Activity link host follows `PAYPAL_ENV`
- [ ] axe clean (WCAG 2.2 AA), 360 px layout, empty/loading/error states; `ui-reviewer` passes

## Deliverables
- `packages/core/src/holds/completed.ts` (+ tests)
- `packages/adapters/src/paypal/trackers-batch.ts`, `apps/worker/src/actions/record-service-completed.ts`
- `apps/web/components/holds/guided-completed.tsx`, `apps/web/e2e/guided-completed.spec.ts`, message keys

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- completed
pnpm --filter ./apps/worker test -- record-service-completed
pnpm --filter ./apps/web exec playwright test e2e/guided-completed.spec.ts --reporter=line > "$TMPDIR/m3-04-e2e.txt"; tail -5 "$TMPDIR/m3-04-e2e.txt"
grep -rn "unconfirmed" apps/web/messages/en.json
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-05 shows the Completed + 7-day estimate
- M3-08 sends the 7-day reminder
- M3-09 reconciles `unknown` executions with the read-back function
- M5-01 states the unconfirmed effect honestly
