---
title: "M3-10 · Review-hold pool tooling"
milestone: "M3 · Holds & Cash"
labels: [backend, owner]
blocked_by: [M3-01]
estimate: "2h"
resources: [PAYPAL_SANDBOX]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-20, P-21, P-46, P-52]
---

## Context
A real `PENDING / PENDING_REVIEW` hold comes only from a **PayPal-wallet payment approved by a buyer in a browser**, with **Payment Review enabled on the sandbox business account** (already on; proven twice on 2026-10-26/28). It releases after about 24 h. The API-only judge path can't create one (B6 #2). So the owner pre-stages a pool:
- one for the video (created **24 h before recording**)
- a small one for judges, with wait times in the README

The storyboard's 0:45–1:05 scene ("a real sandbox payment under review, explained in Hindi") depends on it, as does **Presentation** (real state on camera).

## Scope
- CLI `pnpm --filter ./apps/worker run pool:create -- --count N --purpose video|judge`:
  - creates PayPal-wallet orders (intent CAPTURE, an amount from a synthetic catalogue) owned by a dedicated **pool workspace** (`custom_id` = pool workspace id, `paypal_resource_owner` rows written at creation)
  - prints the buyer-approval URLs only (no secrets)
  - stores `review_hold_pool` rows (order_id, purpose, created_at, state `awaiting_buyer`)
- **Owner step (label `owner`):** the owner opens each approval URL in a browser, logs in as the **sandbox personal (buyer) account** and approves. Credentials stay in the owner's browser and never reach the repo or the CLI.
- CLI `pool:capture`:
  - finds orders that are `APPROVED`
  - captures them with an idempotency key
  - marks the pool rows `held` when the capture is `PENDING/PENDING_REVIEW`, or `not_held` otherwise (recorded, not retried)
  - holds appear through the M3-01 path
- CLI `pool:status`: a table of pool rows with the age and the expected release ("about 24 h after capture", rule `payment_review`).
- **Assignment:**
  - "Try as demo seller" gives a new judge workspace one `held` judge-pool payment, if any is available and is under 20 h old.
  - The assignment moves the `paypal_resource_owner` row from the pool workspace to the judge workspace in one transaction with an audit entry. Only pool-owned rows can move.
  - If none is available, the workspace shows the badged explainer "Review holds need a buyer approval; see README for timing".
  - The `video` purpose is assigned only by `pool:assign --workspace <id>` (the owner's recording workspace).
- Expired items (released to `COMPLETED`) stay as released examples, and are never reassigned as "held".

## Out of scope
- Chargeback (API) judge path: M2-10
- README wait-time wording: M5-01
- Video recording: M5-02
- Synthetic check: M3-09

## Acceptance Criteria
- [ ] Unit/integration: pool creation writes ownership rows; assignment moves exactly one held row and writes an audit entry; a second judge never gets the same capture (concurrency test with two parallel assignments)
- [ ] Assignment refuses rows that are not pool-owned, or are released or older than 20 h
- [ ] Fixture replay (the `fixtures/paypal/captures/pending-review.json` from M3-01, then re-recorded from this ticket's live run): `pool:capture` marks the row `held`, and the hold appears with rule `payment_review`
- [ ] Live (PAYPAL_SANDBOX + owner): 2 judge-pool and 1 video-pool payments are created; the owner approves them as the sandbox buyer; `pool:capture` shows all 3 `held` with `PENDING_REVIEW`; the capture IDs are in the PR
- [ ] CLI output contains no token or credential (grep test on captured output)

## Deliverables
- `apps/worker/src/cli/pool.ts` (create, capture, status, assign) (+ tests)
- `packages/db/` migration for `review_hold_pool` (hot file; coordinate)
- `apps/web` demo-workspace creation hook calling the assignment
- `docs/runbooks/review-hold-pool.md`: owner steps and timing

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./apps/worker test -- pool
pnpm --filter ./apps/worker run pool:status > "$TMPDIR/m3-10-pool.txt"; cat "$TMPDIR/m3-10-pool.txt"
grep -Ei "access_token|client_secret|Bearer " "$TMPDIR/m3-10-pool.txt" && exit 1 || true
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-11 needs a video-pool payment approved **24 h before** the dry run (the owner creates and approves it the day before)
- M3-GATE needs a fresh one again
- M5-01 documents judge-pool wait times
- M5-02 records with a video-pool hold
- M4-07's runbook schedules pool refills during Dec 1–15
