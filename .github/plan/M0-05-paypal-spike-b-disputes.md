---
title: "M0-05 · PayPal spike B: disputes (chargeback, HATEOAS links, supporting info, evidence multipart, adjudicate, timeout/unknown outcome); fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "backend", "blocker-risk", "critical"]
blocked_by: ["M0-04"]
estimate: "4h"
resources: ["PAYPAL_SANDBOX"]
needs: []
---

## Context

The dispute loop is the demo's centre (storyboard 1:05–1:50) and the judge path (M2-10): card
capture → sandbox chargeback → real `PENDING / BUYER_COMPLAINT` hold → evidence → labelled
"Simulate PayPal's decision (sandbox only)" → resolved → released. Dispute replies are
**one-shot** and deadlines are fatal (prior art), so action governance (M2-08) needs recorded proof
of every state, link set and error, plus what an **unknown outcome** (client timeout on a write)
looks like and how a re-fetch resolves it. Technological Implementation and Presentation both rest
on these calls working for real.

Prior evidence (read first; do not copy code): `~/hackathons/.research/paypal-ai-hackathon/spike/dispute_spike.py`,
`poll_dispute.py`, `poll_release.py`, `spike/results/dispute_*.json`, `notes/feasibility.md`
("dispute spike" parts 1, 2 and final: ≈ 20 min lifecycle; `provide-supporting-info` accepted
under `UNDER_REVIEW`; `provide-evidence` only in `WAITING_FOR_SELLER_RESPONSE`; adjudicate allowed
only once its link appears; outcome `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`),
`notes/kickoff/paypal-integration.md` §4 (file limits, evidence types, `seller_response_due_date`, links).

## Scope

Product code (`packages/adapters/src/paypal/disputes.ts`, own typed client on the shared HTTP client; the SDK has no Disputes):
- `processChargeback(captureId, amount)` (sandbox only; refuses when `PAYPAL_ENV != sandbox`)
- `listDisputes({updateTimeAfter})`, `getDispute(id)` with zod schemas for status, stage, reason,
  `seller_response_due_date`, `evidences[].source`, `dispute_outcome`, `links[]`
- `allowedActions(dispute)`: derived **only** from `links[].rel` (never a status map)
- `provideSupportingInfo`, `provideEvidence` (multipart: JSON part + PDF parts; client-side checks:
  jpg/gif/png/pdf, < 10 MB each, ≤ 50 MB per call, notes ≤ 2000 chars), `acceptClaim`,
  `requireEvidence` and `adjudicate` (both sandbox only). Each write takes a `PayPal-Request-Id`
  and refuses if its link rel is absent in a fresh `getDispute`
- A sample evidence PDF generated from synthetic text (`fixtures/samples/evidence/delivery-note.pdf`)

Live runs (`scripts/spikes/paypal-b.ts --record`), each on a fresh card capture from M0-04's helper:
1. **Full path:** chargeback → poll `getDispute` until links change, recording each distinct state
   and link set → `provide-supporting-info` → `WAITING_FOR_SELLER_RESPONSE` → `provide-evidence`
   → `adjudicate` (SELLER_FAVOR) once its link appears → `RESOLVED`; capture GET at each step
   (`PENDING / BUYER_COMPLAINT` → `COMPLETED`)
2. **Errors:** each write before its link exists (`ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`),
   an oversize/invalid-type file rejected client-side, a 2001-char note rejected client-side
3. **Unknown outcome:** a `provide-supporting-info` with a deliberately tiny client timeout →
   `HttpTimeoutError`; then re-fetch the dispute and record whether the write landed (evidence
   list / links / `update_time`), and a retry with the **same** `PayPal-Request-Id` (idempotent or not)
4. **accept-claim** on a third small dispute: record the response and the resulting capture/refund state

Polling stays polite (≥ 60 s apart, give-up after 45 min); record timings.

## Out of scope

- Dispute ingest, mirroring and the deadline watcher (M2-06); action governance (M2-08)
- Reason-code mapping, drafting and the compiled PDF (M2-07); the judge scenario runner (M2-10)
- Webhooks for dispute events (M0-06 records them)

## Acceptance Criteria

- [ ] Live runs 1–4 completed (PAYPAL_SANDBOX claimed); dispute ids and timings in `docs/evidence/m0-05-paypal-spike-b.md`
- [ ] Fixtures cover every distinct dispute state and link set seen, each write's success and its `ACTION_NOT_ALLOWED…` error, the outcome, and the capture before/after
- [ ] Replay tests prove offline: `allowedActions` matches the recorded links in every state; a write without its link is refused **before** any HTTP call; the resolved fixture maps to "seller keeps the money (PayPal covered the case)" (`RESOLVED_WITH_PAYOUT` + `REPRESENTED_BY_PAYPAL`), never "won"
- [ ] Client-side guards tested: bad type, ≥ 10 MB, > 50 MB total, notes > 2000 chars
- [ ] The unknown-outcome finding (landed or not; request-id replay behaviour) is recorded with fixtures and a test that reproduces the reconcile decision
- [ ] `processChargeback`, `requireEvidence` and `adjudicate` throw when `PAYPAL_ENV` is not `sandbox` (test)
- [ ] Scrub checks pass on `fixtures/paypal/disputes/`

## Deliverables

- `packages/adapters/src/paypal/{disputes,dispute-schemas}.ts` + tests
- `scripts/spikes/paypal-b.ts`; `fixtures/paypal/disputes/**/*.json`; `fixtures/samples/evidence/delivery-note.pdf`
- `docs/evidence/m0-05-paypal-spike-b.md` (states, links per state, timings, unknown-outcome finding)

## Validation Gate

```bash
pnpm --filter @cleared/adapters test -- disputes
find fixtures/paypal/disputes -name '*.json' | wc -l                                   # expect >= 12
find fixtures/paypal/disputes -name '*.json' -exec jq -r '.response.body.status // empty' {} \; | sort -u   # expect OPEN, WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED
grep -rl 'RESOLVED_WITH_PAYOUT' fixtures/paypal/disputes | wc -l                       # expect >= 1
grep -rl 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE' fixtures/paypal/disputes | wc -l  # expect >= 1
grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' fixtures/paypal/disputes | grep -vc '@example\.test$'   # expect 0
PAYPAL_ENV=live pnpm --filter @cleared/adapters test -- sandbox-only                   # the guard tests pass
./scripts/landing-checks.sh --fast
```

## Handoff

- **M2-06:** dispute schemas, `listDisputes(updateTimeAfter)`, recorded states for the mirror and deadline watcher
- **M2-07:** evidence-type and file-limit guards, multipart builder
- **M2-08:** `allowedActions`, link re-check, the unknown-outcome finding (drives `executing → unknown → reconcile`)
- **M2-10:** `processChargeback` + `adjudicate` for the labelled sandbox decision; recorded timings for the README wait times
- **M0-06:** the chargebacks here fire `CUSTOMER.DISPUTE.*` webhooks if M0-06's tunnel is up (coordinate; one PAYPAL_SANDBOX holder at a time)
