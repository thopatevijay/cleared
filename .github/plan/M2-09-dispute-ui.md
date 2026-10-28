---
title: "M2-09 · Dispute UI (review draft, approve, filing status, outcome)"
milestone: "M2 · Dispute Loop"
labels: [frontend]
blocked_by: [M2-07, M2-08]
estimate: "5h"
resources: []
needs: []
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
- States: AI unavailable / budget exceeded ("draft unavailable; you can still file manually in PayPal"), too late, kill switch on, empty list, loading, error
- SWR polling every 5 s while executing/unknown or the dispute is open
- Plain-text rendering of all model output; EN + HI strings; WCAG 2.2 AA; mobile-first

## Out of scope
- Draft generation (M2-07) and execution/policy (M2-08); the judge scenario controls (M2-10)
- Email alerts (M3-08); full Hindi review (M4-03)

## Acceptance Criteria
- [ ] Playwright (fixture-backed seed): open the dispute → review the draft → approve → states progress to succeeded (worker on msw fixtures) → outcome text shows exactly the approved wording
- [ ] Deselecting an item produces a new hash; approving the old hash from a second tab shows the `APPROVAL_HASH_MISMATCH` message
- [ ] Character count turns to error above 2000 and disables approve
- [ ] Refusal codes `DEADLINE_PASSED`, `ACTION_LINK_MISSING`, `KILL_SWITCH`, `RECONCILE_NOT_APPLIED` each render a localised message (component tests)
- [ ] Accept claim is disabled until the typed confirmation matches exactly
- [ ] `grep -rniE "seller won|you won" apps/web` finds nothing
- [ ] axe-core: no serious/critical violations; keyboard-only approve flow; 360 px layout; `/hi` has no missing keys
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `apps/web/app/[locale]/disputes/{page.tsx,[disputeId]/page.tsx}`, `components/disputes/{DisputeList,DraftReview,ApproveDialog,AcceptClaimDialog,FilingStatus,Outcome,AuditTrail}.tsx`
- `apps/web/app/api/disputes/{route.ts,[id]/route.ts,[id]/draft/revise/route.ts}`
- `apps/web/messages/en.json`, `hi.json` (dispute keys)
- `apps/web/e2e/dispute-approve.spec.ts`

## Validation Gate
```bash
pnpm --filter ./apps/web exec vitest run components/disputes app/api/disputes
pnpm --filter ./apps/web exec playwright test e2e/dispute-approve.spec.ts
! grep -rniE "seller won|you won" apps/web
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-10 embeds the scenario timeline and the sandbox decision control on this detail page
- M3-08 deep-links alert emails here; M4-03/M4-04 run Hindi and a11y/perf passes on these screens
