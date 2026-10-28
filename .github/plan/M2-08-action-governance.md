---
title: "M2-08 · Action governance (ProposedAction, approval bound to hash, link re-check, deadline refusal, unknown/reconcile, audit)"
milestone: "M2 · Dispute Loop"
labels: [backend, security, critical]
blocked_by: [M2-06]
estimate: "6h"
resources: []
needs: []
---

## Context
"The agent does the work; the seller holds the keys." Dispute replies are effectively one-shot and deadlines are fatal, so every write to PayPal passes one governed path: approval bound to the exact payload, fresh checks immediately before the call, an explicit `unknown` state when the outcome is ambiguous, and an append-only audit trail (ADR 0010, B6 #6, architecture §2/§8/§10). Rubric: Technological Implementation (approval gate), Presentation (audit log on camera).

## Scope
- Core state machine (from M1-01) enforced in `packages/core/src/actions/`: `proposed → approved | rejected`; `approved → executing → succeeded | failed | unknown`; `unknown → succeeded | failed` (reconcile only)
- API (workspace-scoped, zod, Idempotency-Key):
  - `GET /api/actions/:id` (payload, `payload_sha256`, state, refusal reason)
  - `POST /api/actions/:id/approve` body `{payload_sha256, typed_confirmation?}`: rejects if the hash ≠ the stored `payload_sha256` (`APPROVAL_HASH_MISMATCH`); inserts `approvals` (approved_by, approved_at, payload_sha256) + state `approved` + outbox `action.approved` + execution job in one transaction
  - `POST /api/actions/:id/reject`; `POST /api/disputes/:id/accept-claim-proposal` (seller-created `accept_claim` only)
- **Policy in code** (`policy.ts`): `accept_claim` requires `typed_confirmation` equal to the dispute's amount + currency as displayed (e.g. `120.00 USD`) and must not have `created_by_run_id`; unknown kinds refused
- **Execution job** `action.execute` (idempotent; one `executions` row per action with `idempotency_key` = action id, sent as `PayPal-Request-Id`), checks in this order, each refusal → `failed` with a seller-facing code, audit entry, no PayPal write:
  1. kill switch (`AGENT_KILL_SWITCH` env or DB flag) → `KILL_SWITCH`
  2. recompute `canonicalHash(payload)`; must equal the approval's hash → `PAYLOAD_CHANGED`; compiled blob sha256 must match the payload → `BLOB_CHANGED`
  3. ownership: dispute ∈ workspace via `paypal_resource_owner` → `NOT_OWNED`
  4. **re-fetch the dispute** (M2-06 `dispute.sync`) and require the HATEOAS link whose `rel` matches the kind → `ACTION_LINK_MISSING`
  5. `now ≤ seller_response_due_date − 1 h` → `DEADLINE_PASSED`
  6. send (multipart notes + compiled PDF, or accept-claim)
- Outcomes: 2xx → `succeeded` (+ `paypal_status`, `debug_id`, response) and a `dispute.sync`; 4xx → `failed` (business error, not counted by the breaker, no retry); **timeout after send, connection reset after send, or 5xx** → `unknown` and a reconcile job
- **Reconcile** job for `unknown` (delayed 2 min, up to 5 tries with backoff): re-fetch the dispute; the action's link gone **and** status advanced (e.g. `UNDER_REVIEW`) or our evidence listed → `succeeded`; link still present after the last try → `failed` with `RECONCILE_NOT_APPLIED` (the seller may re-approve; never auto-resent)
- Every transition + its outbox event (`action.executed | action.failed | action.unknown`, version 1) in one transaction
- **Audit log**: append-only rows for proposed, approved/rejected (actor seller), each check result, the send (actor system, PayPal debug_id) and the reconcile; DB grants deny UPDATE/DELETE on `audit_log` (migration)

## Out of scope
- Drafting the payload (M2-07); the approve/reject UI (M2-09)
- Sandbox adjudicate (judge control, M2-10; it is a sandbox decision, not a seller action)
- Tracking and Completed actions reuse this path later (M3-03, M3-04)

## Acceptance Criteria
- [ ] Approving with a stale hash returns `APPROVAL_HASH_MISMATCH`; editing the payload after approval makes execution fail `PAYLOAD_CHANGED` without any PayPal request (msw asserts zero calls)
- [ ] Each refusal (kill switch, not owned, link missing, deadline at due − 59 min) is tested with fixtures and makes no PayPal call
- [ ] Replaying M0-05 fixtures: `provide_evidence` multipart 200 → `succeeded` with debug_id; 422 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` → `failed`, breaker untouched
- [ ] Timeout after send (fixture/msw delay) → `unknown`; reconcile with the post-evidence dispute fixture → `succeeded`; with the unchanged fixture → `failed RECONCILE_NOT_APPLIED` after 5 tries
- [ ] Job re-delivery sends at most once (single `executions` row; same `PayPal-Request-Id`)
- [ ] `accept_claim` created by an agent run is refused; seller-created without the exact typed confirmation is refused
- [ ] `UPDATE audit_log` / `DELETE FROM audit_log` as the app role fail (integration test)
- [ ] Every step has an audit row; the sequence for one action reads proposed → approved → checks → sent → succeeded

## Deliverables
- `packages/core/src/actions/{state,policy,checks}.ts` + tests
- `apps/worker/src/jobs/{execute-action,reconcile-action}.ts` + int tests
- `apps/web/app/api/actions/[id]/{route,approve/route,reject/route}.ts`, `apps/web/app/api/disputes/[id]/accept-claim-proposal/route.ts`
- `packages/db/src/repositories/{approvals,executions,audit-log}.ts`, migration for audit grants

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/actions
pnpm --filter ./apps/worker exec vitest run src/jobs/execute-action src/jobs/reconcile-action
pnpm --filter ./apps/web exec vitest run app/api/actions
pnpm --filter ./packages/db exec vitest run -t "audit_log grants"
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-09 calls approve/reject/accept-claim-proposal and renders the states and refusal codes
- M2-10 and M2-GATE prove the path live (this ticket proves it on fixtures only)
- M3-03/M3-04 add tracking and Completed kinds to `policy.ts`; M4-05 cites these tests in the security review
