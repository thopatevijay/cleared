---
title: "M2-06 · Dispute ingest + deadline watcher (sync, HATEOAS actions, due date)"
milestone: "M2 · Dispute Loop"
labels: [backend, critical]
blocked_by: [M1-GATE]
estimate: "4h"
resources: [PAYPAL_SANDBOX]
needs: []
---

## Context
Disputes are the loop's trigger and its fatal deadline. Cleared must mirror PayPal's dispute state exactly, never trust webhook order, keep the current HATEOAS links as the only source of allowed actions, and never miss `seller_response_due_date` (architecture §2, §6; ADR 0008, 0011; prior-art lesson). Rubric: Technological Implementation (real Disputes API use).

## Scope
- Typed Disputes client in `packages/adapters/src/paypal/disputes.ts` (own client, shared HTTP client + token provider, `PayPal-Request-Id` on writes, `debug_id` captured):
  - reads: `GET /v1/customer-support/disputes/{id}`, list by `disputed_transaction_id`
  - writes used later by M2-08/M2-10: `provide-evidence` and `provide-supporting-info` (multipart: JSON part + files), `accept-claim`, sandbox `adjudicate`
  - zod schemas for the response shapes recorded in M0-05 (`fixtures/paypal/disputes/`)
- Ingest: webhook types `CUSTOMER.DISPUTE.CREATED | UPDATED | RESOLVED` (stored raw by M1-04) enqueue `dispute.sync`; the job **re-fetches** the dispute and upserts the mirror
- `dispute.sync` (idempotent on dispute id + PayPal `update_time`; older `update_time` never overwrites newer):
  - link to the payment via `disputed_transactions[].seller_transaction_id` = capture id
  - **ownership**: owner inherited from the capture's `paypal_resource_owner` row and written for the dispute; no owner → quarantine (stored in `webhook_events`/a `quarantined` flag, no dispute row, audit entry, Sentry breadcrumb)
  - store status, stage, reason, amount, `seller_response_due_date`, outcome, and `allowed_actions` = the `rel`s of the current `links` (excluding `self`)
  - state change + outbox `dispute.opened` / `dispute.status_changed` (version 1) in one transaction; then enqueue the capture sync job (M1-04) so the linked hold (`PENDING/BUYER_COMPLAINT`) appears
- Targeted `dispute.sync` by id (used by M2-10's scenario poll and after M2-08 executions)
- **Deadline watcher** (pg-boss cron every 15 min, plus on each sync): for open disputes with a due date, writes `notifications` rows `dispute_deadline_72h` and `dispute_deadline_24h` once each (unique per dispute + kind) and sets `disputes.deadline_state` (`ok | t72 | t24 | closed_for_action` at due − 1 h)

## Out of scope
- Email delivery of the alerts (M3-08); the global reconcile poll (M3-09)
- Drafting (M2-07); executing writes and their policy checks (M2-08); dispute screens (M2-09)

## Acceptance Criteria
- [ ] Replaying M0-05 fixtures: the dispute is mirrored with status, reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, stage, due date, and `allowed_actions` = `provide_supporting_info` (UNDER_REVIEW) then `accept_claim, provide_evidence` (WAITING_FOR_SELLER_RESPONSE)
- [ ] Webhooks delivered out of order (RESOLVED before UPDATED) end in the RESOLVED state with outcome `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`
- [ ] Duplicate jobs write no second outbox row
- [ ] A dispute whose capture has no owner is quarantined: no `disputes` row, an audit entry exists
- [ ] Watcher: with the clock at due − 71 h one `dispute_deadline_72h` notification; at due − 23 h one `dispute_deadline_24h`; re-runs add none; at due − 59 min `deadline_state = closed_for_action`
- [ ] A 500 then 200 from the dispute GET retries; a 404 does not retry and does not trip the breaker
- [ ] Live proof (claims PAYPAL_SANDBOX): `GET` of the M0-05 dispute and one capture-linked lookup on the sandbox parse with the zod schemas

## Deliverables
- `packages/adapters/src/paypal/disputes.ts`, `disputes.schemas.ts` + tests
- `packages/core/src/disputes/{mirror,deadline}.ts` + tests (pure: allowed actions from links, deadline state from a clock)
- `apps/worker/src/jobs/{dispute-sync,deadline-watcher}.ts` + int tests
- `packages/db/src/repositories/disputes.ts`

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/disputes
pnpm --filter ./packages/adapters exec vitest run src/paypal/disputes
pnpm --filter ./apps/worker exec vitest run src/jobs/dispute-sync src/jobs/deadline-watcher
pnpm --filter ./packages/adapters exec vitest run src/paypal/disputes.live.test.ts   # live, PAYPAL_SANDBOX; skipped without PAYPAL_CLIENT_ID
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-07 reads the mirror (reason, `allowed_actions`, requested evidence) and the due date
- M2-08 uses the client's writes and `dispute.sync` for the pre-execution re-fetch and reconcile
- M2-10 calls targeted `dispute.sync`; M3-08 emails from the watcher's notifications; M3-09 reuses `dispute.sync` in the reconcile poll
