---
title: "M2-10 · Judge scenario runner (card capture with custom_id, chargeback, ownership table, labelled \"Simulate PayPal's decision (sandbox only)\")"
milestone: "M2 · Dispute Loop"
labels: [backend, frontend, critical]
blocked_by: [M2-08]
estimate: "5h"
resources: [PAYPAL_SANDBOX, OPENAI]
needs: []
---

## Context
Judges have no keys and no PayPal buyer login, yet the demo must be functional with real sandbox calls (hackathon rules; B6 #1, #2). The M0-05 spike proved an API-only path in about 20 minutes: card capture → `POST /v2/customer-support/process-chargeback` → dispute (`MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`) → capture `PENDING / BUYER_COMPLAINT` → evidence → sandbox `adjudicate` SELLER_FAVOR → capture `COMPLETED` → dispute `RESOLVED`, `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`. This ticket turns that into a one-click, isolated scenario per demo workspace. Rubric: Stage One (functional demo), Presentation, Technological Implementation.

## Scope
- "Run the dispute scenario" on the demo dashboard (demo workspaces and the owner's workspace only), one active scenario per workspace; a `scenario_runs` row tracks steps (added via migration)
- Steps, each a pg-boss job (nothing slow in the request), each step's state + outbox in one transaction:
  1. **Card capture**: Orders create + capture (SDK, shared HTTP client) for $120.00 USD with a PayPal-published sandbox test card and a synthetic buyer; `purchase_units[].custom_id = workspace_id`. In the same transaction as the `payments` row: `paypal_resource_owner` rows for the order and the capture; outbox `payment.captured`
  2. **Seed the pack** with the canned synthetic evidence set (scope chat, delivery PDF, acceptance message) through the M2-01 path; identical bytes → content-hash AI cache hits after the first run
  3. **Sandbox chargeback**: `POST /v2/customer-support/process-chargeback` on the capture; the dispute id is written to `paypal_resource_owner` on creation (ingest also inherits it)
  4. **Scenario poll**: targeted `dispute.sync` + capture sync every 30 s for this scenario's ids only, bounded to 60 min, stopping at a terminal state (works without webhooks, e.g. on a local stack)
- Progress timeline on the dispute page (M2-09): each step with real PayPal ids, timestamps and the observed status; expected waits stated from the spike ("PayPal usually opens the evidence step within ~15 min")
- **"Simulate PayPal's decision (sandbox only)"** control, visibly labelled as a sandbox stand-in for PayPal's own review:
  - shown only when `PAYPAL_ENV=sandbox`; enabled only when the workspace owns the dispute, our evidence was filed, and the freshly re-fetched dispute carries the `adjudicate` link (else a "PayPal isn't ready yet" message)
  - calls the sandbox-only `POST /v1/customer-support/disputes/{id}/adjudicate` with `SELLER_FAVOR` through the M2-06 client; audit entry with actor `seller` and `detail.sandbox_decision = true`
  - the result is mirrored only from PayPal (dispute sync); the UI never sets an outcome itself
- Outcome copy: "Resolved; seller keeps the money (PayPal covered the case)" (EN + HI); hold released when the capture reads `COMPLETED`
- Caps: inherits M1-05 demo caps; a scenario can't start while the global LLM cap is reached (shows why)
- Playwright spec `apps/web/e2e/judge-dispute.live.spec.ts` driving the whole path as a judge (used by M2-GATE)

## Out of scope
- Dispute ingest/sync (M2-06), drafting (M2-07), approval/execution (M2-08), the dispute screens (M2-09)
- Review-hold (`PENDING_REVIEW`) pool (M3-10); daily synthetic check of this path (M3-09); production run (M3-11)

## Acceptance Criteria
- [ ] Fixture replay (M0-04/M0-05): the runner creates order + capture with `custom_id = workspace_id`, writes three `paypal_resource_owner` rows (order, capture, dispute), and walks the step states to `resolved`
- [ ] Two demo workspaces running scenarios at once never see each other's payments or disputes (int test with two workspaces on fixtures)
- [ ] The decision control is absent when `PAYPAL_ENV` ≠ `sandbox`, and disabled without the `adjudicate` link (component + API tests); the API refuses a direct call in both cases
- [ ] Re-delivering any step job makes no second PayPal create/chargeback call (`PayPal-Request-Id` per step)
- [ ] The poll stops at terminal state or 60 min; no poll runs for finished scenarios
- [ ] `grep -rniE "seller won|you won" apps packages` finds nothing
- [ ] Live proof (claims PAYPAL_SANDBOX): one full run on the sandbox reaches dispute `RESOLVED` with `RESOLVED_WITH_PAYOUT` and capture `COMPLETED`; the ids and timings are recorded in `.dev-refs.md` (private) and the step timeline

## Deliverables
- `packages/core/src/scenarios/judge-dispute.ts` (step machine, pure) + tests
- `apps/worker/src/jobs/scenario/{capture,seed-pack,chargeback,poll}.ts` + int tests
- `packages/adapters/src/paypal/orders.ts` (card order + capture with custom_id), `chargeback.ts`
- `apps/web/app/api/scenarios/{route.ts,[id]/route.ts,[id]/decide/route.ts}`, `components/scenario/{ScenarioTimeline,SandboxDecision}.tsx`
- `fixtures/scenario/` synthetic evidence set; migration for `scenario_runs`
- `apps/web/e2e/judge-dispute.live.spec.ts`

## Validation Gate
```bash
pnpm --filter ./packages/core exec vitest run src/scenarios
pnpm --filter ./apps/worker exec vitest run src/jobs/scenario
pnpm --filter ./apps/web exec vitest run components/scenario app/api/scenarios
! grep -rniE "seller won|you won" apps packages
pnpm --filter ./apps/web exec playwright test e2e/judge-dispute.live.spec.ts --timeout=3600000   # live, PAYPAL_SANDBOX + OPENAI cache
./scripts/landing-checks.sh --fast
```

## Handoff
- M2-GATE runs `judge-dispute.live.spec.ts` from a clean stack
- M3-09 calls the same scenario daily as the synthetic judge-path check; M3-11 runs it on production
- M5-01/M5-02 use the timeline and the labelled control in the README and video
