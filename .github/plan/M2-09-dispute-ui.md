---
title: "M2-09 · Dispute UI (review draft, approve, filing status, outcome)"
milestone: "M2 · Dispute Loop"
labels: [frontend]
blocked_by: [M2-07, M2-08]
estimate: "5h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14]
---

## Context
The seller's approval moment is the core of the storyboard (1:05–1:50) and of the trust story: she sees exactly what will be filed, approves that exact payload, and watches real PayPal state change. Wording must stay honest: the sandbox outcome is "resolved; seller keeps the money (PayPal covered the case)", never "won". Rubric: Design, Presentation, Technological Implementation. Built to `docs/design/` (M1-06).

## Scope
- Routes: `apps/web/app/[locale]/disputes/page.tsx` (list) and `disputes/[disputeId]/page.tsx` (detail); read APIs `GET /api/disputes` and `GET /api/disputes/:id` (mirror + linked payment/hold + draft + proposed action + audit entries), workspace-scoped
- **List**: PayPal status and stage as PayPal reports them, reason, amount, due date in the seller's time zone with a countdown, deadline badge (`t72`, `t24`, `closed_for_action`)
- **Detail**:
  - PayPal facts: status, reason, the linked capture and its hold (`PENDING / BUYER_COMPLAINT`), allowed actions from the current links
  - **Draft review**: notes as plain text with a live character count (`n / 2000`), the evidence type and the reason-map explanation, the selected evidence items (toggle to deselect; links to the pack via M2-05's `Citation`), compiled PDF download, the short payload hash being approved
  - Seller edits to notes or the selection call `POST /api/disputes/:id/draft/revise` (validation + compile + new proposal, no model call) and the approve button binds to the new hash
  - **Approve** sends `{payload_sha256}`; confirm dialog states what will be sent to PayPal and that it cannot be withdrawn
  - **Accept claim** (secondary, destructive styling): typed confirmation of the amount + currency
  - **Filing status**: proposed / approved / executing / `unknown` ("checking with PayPal") / succeeded / failed with the localised refusal or PayPal error code and `debug_id`
  - **Outcome**: mirrored outcome; `RESOLVED_WITH_PAYOUT` + `REPRESENTED_BY_PAYPAL` renders exactly "Resolved; you keep the money (PayPal covered the case)" (EN) and its HI string; other outcomes render their PayPal meaning
  - **Audit trail** panel: actor, action, time, debug_id
- **Workspace audit-log page** (owner decision 2026-10-30, BL-01): route `apps/web/app/[locale]/audit/page.tsx` replaces M1-07's placeholder, built to `docs/design/screens/audit-log.md`; read API `GET /api/audit` (workspace-scoped, cursor pagination 50 per page, filters actor / kind / ID search). Rows grouped by day, newest first (`AuditRow`): actor, action, result, references (dispute ID, `debug_id`, fingerprint, correlation); expandable detail as plain text; no edit, delete or export; SWR 5 s with a polite batched announcement; loading, empty, filtered-empty, partial, error states
- **Dashboard elements** (`docs/design/screens/dashboard.md`, elements 3b, 4, 5): the `SummaryBar` "{amount} in dispute" total per currency (replaces the M1 "—"), the dispute `PaymentRow` (`dispute` badge, PayPal status, reason "Item not as described", due date), and the secondary button "Review and approve" shown when a draft is ready (no one-tap approve; it opens dispute review with focus on the `ApprovalCard`)
- States: AI unavailable / budget exceeded ("draft unavailable; you can still file manually in PayPal"), too late, kill switch on, empty list, loading, error
- SWR polling every 5 s while executing/unknown or the dispute is open
- Plain-text rendering of all model output; EN + HI strings; WCAG 2.2 AA; mobile-first

## Out of scope
- Audit data and its append-only grants (M2-08); the footer link and placeholder route (M1-07)
- Draft generation (M2-07) and execution/policy (M2-08); the judge scenario controls (M2-10)
- Email alerts (M3-08); full Hindi review (M4-03)

## Acceptance Criteria
- [ ] Playwright (fixture-backed seed): open the dispute → review the draft → approve → states progress to succeeded (worker on msw fixtures) → outcome text shows exactly the approved wording
- [ ] Deselecting an item produces a new hash; approving the old hash from a second tab shows the `APPROVAL_HASH_MISMATCH` message
- [ ] Character count turns to error above 2000 and disables approve
- [ ] Refusal codes `DEADLINE_PASSED`, `ACTION_LINK_MISSING`, `KILL_SWITCH`, `RECONCILE_NOT_APPLIED` each render a localised message (component tests)
- [ ] Accept claim is disabled until the typed confirmation matches exactly
- [ ] Playwright `audit-log.spec.ts` (after the approve flow): `/en/audit` lists the sequence proposed → approved → checks → sent → mirrored outcome, newest first, grouped by day, each row with actor icon + word, and the `debug_id` on the sent row; no row offers edit or delete
- [ ] Audit filters: Actor and Kind narrow the list, the ID search finds a dispute ID and a `debug_id`, and "No entries match these filters." with "Clear filters" shows for no match; "Load older" fetches the next 50 and a failed fetch keeps loaded rows with Retry (component tests)
- [ ] `GET /api/audit` from another workspace returns none of this workspace's rows (integration test); an expanded row renders `detail` as literal text (`<script>` in a detail renders literally) and never shows evidence text or buyer messages
- [ ] Audit page placeholder from M1-07 is gone: `/hi/audit` renders every string from `messages/hi.json`, and the empty state shows "Nothing yet. Every proposal, approval and PayPal call will be recorded here."
- [ ] Playwright `dashboard-disputes.spec.ts`: with a seeded open dispute the summary shows "$120.00 USD in dispute" (no "—"); the dispute row shows the `dispute` badge, "Item not as described" and the due date; "Review and approve" opens the dispute detail with focus on the `ApprovalCard`; with no draft ready the button is absent
- [ ] Clicking the "in dispute" summary fact applies `?filter=dispute` and lists only dispute rows; with disputes failing to load the summary shows "—" and the inline "Couldn't load disputes. Payments are up to date." band
- [ ] `grep -rniE "seller won|you won" apps/web` finds nothing
- [ ] axe-core: no serious/critical violations; keyboard-only approve flow; 360 px layout; `/hi` has no missing keys
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `apps/web/app/[locale]/disputes/{page.tsx,[disputeId]/page.tsx}`, `components/disputes/{DisputeList,DraftReview,ApproveDialog,AcceptClaimDialog,FilingStatus,Outcome,AuditTrail}.tsx`
- `apps/web/app/[locale]/audit/page.tsx`, `apps/web/components/audit/{AuditRow,AuditFilters,AuditList}.tsx`, `apps/web/app/api/audit/route.ts`, `apps/web/e2e/audit-log.spec.ts`
- Dashboard additions in `apps/web/components/payments/` (`SummaryBar` dispute total, dispute `PaymentRow` variant, "Review and approve" action), `apps/web/e2e/dashboard-disputes.spec.ts`
- `apps/web/app/api/disputes/{route.ts,[id]/route.ts,[id]/draft/revise/route.ts}`
- `apps/web/messages/en.json`, `hi.json` (dispute keys)
- `apps/web/e2e/dispute-approve.spec.ts`

## Validation Gate
```bash
pnpm --filter ./apps/web exec vitest run components/disputes app/api/disputes
pnpm --filter ./apps/web exec playwright test e2e/dispute-approve.spec.ts e2e/audit-log.spec.ts e2e/dashboard-disputes.spec.ts
! grep -rniE "seller won|you won" apps/web
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-11 (storyboard 1:50–2:15) and M3-GATE (step 7) rely on the audit-log page built here
- M2-10 embeds the scenario timeline and the sandbox decision control on this detail page
- M3-08 deep-links alert emails here; M4-03/M4-04 run Hindi and a11y/perf passes on these screens
