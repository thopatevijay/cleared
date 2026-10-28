---
title: "M3-01 · Hold derivation + cited rule table + hold UI"
milestone: "M3 · Holds & Cash"
labels: [backend, frontend, critical]
blocked_by: [M2-GATE]
estimate: "5h"
resources: []
needs: []
---

## Context
Pillar P2 (held-money inbox) answers the opacity pain ("frozen with little explanation"). It drives **Potential Impact** (cash freed, visible) and **Design** (one coherent journey), and the storyboard's 0:45–1:05 scene. The ADR 0009 `explain_hold` workflow and every later M3 ticket read the hold and its cited rule. B6 #4 fixed the definition: **hold = capture `status == PENDING` + `status_details.reason`**, plus dispute-linked holds (`BUYER_COMPLAINT`). Release dates are **estimates** from a cited PayPal rule, never promises.

## Scope
- `packages/core/src/holds/` (no I/O): `deriveHold(capture, dispute?)` returns `null` or `{ type, reason, openedAt, estimatedReleaseAt | null, estimateRuleId }`. Payment states mirror PayPal only. The Hold state machine follows architecture §2 (`open → explained → action_proposed → approved → filed → released | still_held`). `released` is set only when the mirrored capture leaves `PENDING`.
- `packages/core/src/holds/rules.ts`: the **cited rule table**, versioned data. Each row has `id`, `appliesTo`, `estimate(fromDate)` and `source { url, quote, retrieved_at }`. Rows:
  - `payment_review` (`PENDING_REVIEW`): "up to 24 hours". Sources: the Transaction event codes page (T2105, "Payment review hold") and the PayPal seller hold panel text "normally takes up to 3 business days" (sandbox UI, 2026-10-28). The estimate shows 24 h, with the 3-business-day upper bound alongside it.
  - `dispute_hold` (`BUYER_COMPLAINT`, `CHARGEBACK`): released when the linked dispute resolves. No date; the dispute deadline is shown instead.
  - `goods_delivered` (help129): "approximately 24 hours after the courier confirms delivery" (approved carriers only; used by M3-03).
  - `service_completed` (help129): "7 days after you confirm the order status as Completed" (used by M3-04).
  - Every other `capture_status_details.reason` enum value (ECHECK, UNILATERAL, VERIFICATION_REQUIRED, RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION, INTERNATIONAL_WITHDRAWAL, TRANSACTION_APPROVED_AWAITING_FUNDING, OTHER, …): the spec's own description as the source, with `estimate = null` ("PayPal gives no timeline").
  - **Sample scenarios** (`new_seller_21d`, `reserve`, `limitation`): explainers only, flagged `sample: true`. They are never derived from a capture and are always shown with a "Sample scenario: sandbox can't produce this" badge.
- Holds module: the `payment.status_changed` / `dispute.opened` consumers derive or close holds. Each writes the `holds` row and the `hold.opened` / `hold.released` outbox row in **one transaction**, and is idempotent (keyed on capture_id + reason + opened_at). It reuses the `holds` table from M1-02. A missing column is added as a forward migration (hot file `packages/db/schema/*`, coordinate).
- REST: `GET /api/holds`, `GET /api/holds/:id`. Workspace-scoped, zod response schema, ownership checked against `paypal_resource_owner`.
- UI (to `docs/design/`): a held-money inbox (total held per currency, list) and a hold detail page (amount, reason, estimated release with a "Source" disclosure showing the quote + link, the dispute link if any). A "Sample scenarios" section holds the three badged explainers. Empty, loading and error states; mobile-first; EN/HI message keys; SWR refresh every 5 s.

## Out of scope
- AI explanation text: M3-02
- Tracking and route advice: M3-03
- Guided Completed: M3-04
- Calendar view: M3-05
- Alerts: M3-08
- Poll-based mirroring: M3-09
- Full Hindi translation pass: M4-03

## Acceptance Criteria
- [ ] Unit tests: each recorded capture fixture maps to the expected hold, including `PENDING_REVIEW`, `BUYER_COMPLAINT` (M0-05 fixture) and `COMPLETED` (no hold). M0-04 records no wallet-review capture, so this ticket copies the real recorded responses from `~/hackathons/.research/paypal-ai-hackathon/spike/results/wallet_review.json` and `wallet_review_after.json` (2026-10-26/28) into `fixtures/paypal/captures/`, with a provenance note and any tokens/PII stripped
- [ ] Every `capture_status_details.reason` enum value in the Orders spec has a rule row; a test fails if one is missing
- [ ] Every rule row has a non-empty `source.url`, `source.quote` and `retrieved_at`; the estimate label is always "estimated"
- [ ] Sample-scenario rows can't be returned by `deriveHold` (property test over all reasons)
- [ ] Replaying the M0-05 dispute fixtures (chargeback → `PENDING/BUYER_COMPLAINT` → `COMPLETED`) produces exactly one `hold.opened` and one `hold.released` outbox row; replaying twice adds none
- [ ] `GET /api/holds` from another workspace returns 404 for a foreign hold (integration test)
- [ ] Playwright: the inbox and detail render with fixture data; the empty, loading and error states render; axe shows no WCAG 2.2 AA violations; layout works at 360 px
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `packages/core/src/holds/{derive.ts,rules.ts,state.ts,index.ts}`, `packages/core/src/holds/*.test.ts`
- `apps/worker/src/consumers/holds.ts` (+ tests)
- `apps/web/app/api/holds/**`, `apps/web/app/[locale]/holds/**`, `apps/web/components/holds/**`
- `apps/web/messages/{en,hi}.json` (hold keys), `apps/web/e2e/holds.spec.ts`
- `fixtures/paypal/captures/{pending-review.json,pending-review-released.json,PROVENANCE.md}`
- Migration under `packages/db/` if a column is missing

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- holds
pnpm --filter ./apps/worker test -- holds
pnpm --filter ./apps/web test -- holds
pnpm --filter ./apps/web exec playwright test e2e/holds.spec.ts --reporter=line > "$TMPDIR/m3-01-e2e.txt"; tail -5 "$TMPDIR/m3-01-e2e.txt"
grep -c "retrieved_at" packages/core/src/holds/rules.ts
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-02 needs `estimateRuleId`, the rule row (quote + url) and the hold fields as grounded input
- M3-03 and M3-04 use the `goods_delivered` and `service_completed` rules and the hold detail page's action slot
- M3-05 reads `estimatedReleaseAt` + amount per hold
- M3-08 consumes `hold.opened`
- M3-09 mirrors captures by poll into the same consumer
- M3-10 needs `PENDING_REVIEW` holds to appear in a workspace
