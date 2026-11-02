---
title: "M3-03 · Tracking action + two-tier carrier map + route advice"
milestone: "M3 · Holds & Cash"
labels: [backend, frontend, owner]
blocked_by: [M3-01]
estimate: "5h"
resources: [PAYPAL_SANDBOX]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-13, P-14, P-21, P-46, P-51]
---

## Context
For goods, PayPal help129 says: "Use one of our approved shipping carriers, and we'll release the hold approximately 24 hours after the courier confirms delivery." PayPal support defines "approved" as the **"Shipped by" dropdown** in Add Tracking Info. That dropdown has 834 codes (incl. `OTHER`) and is a subset of the API carrier list. National posts that many sellers rely on are **not** in it. Goods-tracking automation is PayPal's own Package Tracking Solution, so **ours is one approved action**. The value we add is the two-tier map and **route advice before shipping** (pillar P5, prevention → **Impact**; Orders Track API → **Tech**; storyboard 0:45–1:05 "route advice on a goods order").

## Scope
- **Data files** (recorded, never hand-typed):
  - `packages/core/data/carriers/shipped-by-dropdown.json`: `{ source, captured_at, account: "US sandbox business", count, codes[] }`. Captured read-only from the owner's logged-in sandbox browser: Activity → a payment → More actions → Add tracking info → "Shipped by" options; nothing saved. **Owner step (~10 min):** the owner opens the session; the worker reads the options with claude-in-chrome.
  - `packages/core/data/carriers/api-carriers.json`: code, name, country, from developer.paypal.com/docs/tracking/reference/carriers/, with `source` + `retrieved_at`. *Amended 2026-11-02 (owner decision on #35: probe, then amend):* a dropdown code missing from that page is probed against the sandbox track API. If PayPal accepts it, it's added with a per-carrier `source` (an `additional_sources` id) and its `debug_id`. If PayPal rejects it, it goes into a named exception list (data plus the subset test), each entry citing the dropdown capture and the rejecting `debug_id`. The 2026-11-02 probe accepted all 9 gaps (`fixtures/paypal/tracking/carrier-probe/`), so the exception list is empty.
  - A test asserts `count == codes.length`. If the count differs from the 834 seen on 2026-10-26, the PR notes it (source of truth = the new capture).
- **Two-tier map** in `packages/core/src/carriers/` (no I/O):
  - `approved`: in the dropdown. Copy: "faster release expected: about 24 h after delivery is confirmed".
  - `accepted`: in the API list only. Copy: "PayPal accepts it; it may not speed up the release". Examples: INDIA_POST, KENYA_POST, NIGERIAN_POST, GHANA_POST, PAKISTAN_POST, BANGLADESH_POST, EGYPT_POST, JTEXPRESS_PH, SPX_PH.
  - `other`: free-text `carrier_name_other` ≤ 64 chars. Same copy as `accepted`, with "unconfirmed".
  - Each tier cites its source and date. A caveat is always shown: "sandbox US account list; live and other-country accounts may differ".
- **Route advice:** `adviseRoute(country, chosenCode?)` returns the approved carriers for that country (e.g. IN → IND_DELHIVERY, DTDC_IN, EKART, BLUEDART; NG → NIPOST_NG; ID → IDN_JNE; PK → TCS). If the chosen carrier is tier `accepted`/`other`, it flags the carrier and suggests approved alternatives. It is shown on goods payments before tracking is filed, and as a prevention nudge.
- **Tracking action:** ProposedAction `add_tracking` (payload: order id, capture id, carrier code or OTHER + name, tracking number, notify_payer=false), prefilled from `extracted_facts` of `shipment` evidence (M2-03). The seller approves it; the approval is bound to the payload sha256 (M2-08). Execution:
  - re-checks ownership and the kill switch
  - calls `POST /v2/checkout/orders/{id}/track` via our typed PayPal client (`PayPalOrdersClient.trackOrder`, no PayPal SDK, ADR 0011 addendum) on the shared token provider/HTTP client, with an idempotency key
  - stores `executions` + `paypal_debug_id`
  - writes the audit log
  - Unknown outcome → reconcile by reading the order's trackers.
- **Dashboard elements** (`docs/design/screens/dashboard.md`, elements 10, 11, 12): on a goods hold row, the route-advice line with `triangle-alert` icon + text, e.g. "India Post: PayPal accepts it; it may not speed up the release. Faster: Delhivery, DTDC, Ekart, Blue Dart", with Source and the sandbox caveat (replaces the wireframe's "not approved"); and the secondary button "File tracking" opening the hold detail with focus on the `ApprovalCard` for `add_tracking`
- After filing, the hold's estimate switches to `goods_delivered` with the date "pending courier delivery confirmation" (no fabricated date).

## Out of scope
- Service Completed: M3-04
- Automating tracking for every order: PayPal's product, excluded
- Poll reconciliation of `unknown`: M3-09 (this ticket provides the reconcile function)
- Hindi copy review: M4-03

## Acceptance Criteria
- [ ] Both data files exist with `source`, `captured_at`/`retrieved_at` and a count; a test checks that every dropdown code except `OTHER` exists in the API list. The API list is the developer page plus the sandbox-probed codes, each citing its source and `debug_id`. The only allowed exceptions are codes named in an exception list, each citing the 2026-11-02 dropdown capture and PayPal's rejecting `debug_id` (empty after the 2026-11-02 probe). Any other gap fails the test. *(Amended 2026-11-02, owner decision on #35.)*
- [ ] Tests: IND_DELHIVERY, DTDC_IN, EKART, BLUEDART, NIPOST_NG, IDN_JNE and TCS are `approved`; INDIA_POST, KENYA_POST, NIGERIAN_POST, GHANA_POST, PAKISTAN_POST, BANGLADESH_POST, EGYPT_POST, JTEXPRESS_PH and SPX_PH are `accepted`; free text is `other`
- [ ] `adviseRoute("IN", "INDIA_POST")` flags it and returns approved IN alternatives (unit test)
- [ ] Fixture replay (M0-04 `track` fixtures): an approved `add_tracking` executes, and the execution + audit rows are written; a changed payload after approval is refused (hash mismatch)
- [ ] Live (PAYPAL_SANDBOX): one approved `add_tracking` with IND_DELHIVERY on a Cleared-owned sandbox order returns 201; the `debug_id` is recorded in the PR
- [ ] Playwright `dashboard-tracking.spec.ts`: a goods hold row with an `accepted` carrier (INDIA_POST) shows the route-advice line with the approved alternatives, Source and the caveat, as icon + text; an `approved` carrier shows no warning
- [ ] "File tracking" on the goods hold row opens the hold detail with focus on the `add_tracking` `ApprovalCard`; once tracking is filed the button and the advice line are gone
- [ ] No "not approved" string exists in `apps/web` (`grep -rn "not approved" apps/web` finds nothing)
- [ ] UI: tier badges, route advice and the approval dialog pass axe (WCAG 2.2 AA) and work at 360 px; `ui-reviewer` passes

## Deliverables
- `packages/core/data/carriers/{shipped-by-dropdown.json,api-carriers.json}`
- `packages/core/src/carriers/{tiers.ts,advice.ts}` (+ tests)
- `packages/adapters/src/paypal/tracking.ts`, `apps/worker/src/actions/add-tracking.ts`
- `apps/web/components/tracking/**`, `apps/web/e2e/tracking.spec.ts`, `apps/web/e2e/dashboard-tracking.spec.ts`, dashboard additions in `apps/web/components/payments/` (route-advice line, "File tracking" action), message keys

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
python3 -I -c "import json;d=json.load(open('packages/core/data/carriers/shipped-by-dropdown.json'));assert d['count']==len(d['codes']) and d['source'] and d['captured_at'];print(d['count'])"
pnpm --filter ./packages/core test -- carriers
pnpm --filter ./apps/worker test -- add-tracking
pnpm --filter ./apps/web exec playwright test e2e/tracking.spec.ts e2e/dashboard-tracking.spec.ts --reporter=line > "$TMPDIR/m3-03-e2e.txt"; tail -5 "$TMPDIR/m3-03-e2e.txt"
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-05 shows the post-tracking state
- M3-08 can nudge on route advice
- M3-09 calls the tracker reconcile for `unknown` executions
- M3-11 shows route advice on a goods order (storyboard 0:45–1:05)
- M5-01 cites the two-tier map and its capture date
