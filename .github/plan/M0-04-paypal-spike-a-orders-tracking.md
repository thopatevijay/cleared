---
title: "M0-04 · PayPal spike A: token provider, shared HTTP client, card order + capture with custom_id, Orders track, trackers-batch COMPLETED, capture GET; fixtures + replay helper"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "backend", "blocker-risk"]
blocked_by: ["M0-02"]
estimate: "4h"
resources: ["PAYPAL_SANDBOX"]
needs: []
---

## Context

Stage One is pass/fail on "reasonably applies the required APIs", and Technological Implementation
names the PayPal APIs exercised for real. The research spike (Python, 2026-10-26/28) proved the
calls; this ticket writes the **product foundation fresh in TypeScript** and records real responses
so every later ticket tests by replay, not by live calls (data policy: no mocks in the product path;
tests replay recorded real responses). It also fixes the fixture format and replay helper that
M0-05, M0-06 and M0-07 reuse.

Prior evidence (read first; do not copy code):
`~/hackathons/.research/paypal-ai-hackathon/spike/spike.py`, `spike/wallet_order.py`,
`spike/results/{auth,order,track,service}.json`, `notes/feasibility.md` (Live table),
`notes/kickoff/paypal-integration.md` §3 (SDK coverage, default `timeout: 0`) and §5 (rate limits,
`PayPal-Request-Id`, token lifetime, cached-scope gotcha).

## Scope

Product code (`packages/adapters`, built to ADR 0011):
- `src/http/client.ts`: the **one shared HTTP client** on `fetch`: per-call timeout
  (`AbortSignal.timeout`; PayPal 10 s), retries only on timeout / 5xx / 429 with full-jitter
  backoff and `Retry-After`, one circuit breaker counting only those errors, a correlation-id
  header, PayPal `paypal-debug-id` captured on every response, typed errors
  (`HttpTimeoutError` = outcome unknown for writes), and an `onExchange` hook (used by the recorder)
- `src/paypal/token.ts`: one token provider: cached per client id, single-flight, refreshed
  5 min before `expires_in`, one forced refresh on a 401; scopes exposed (to detect the missing
  Transaction Search scope)
- `src/paypal/orders.ts`: create order (card `payment_source`, `custom_id`, `PayPal-Request-Id`),
  capture, get order, get capture, Orders v2 track (`POST /v2/checkout/orders/{id}/track`),
  legacy `POST /v1/shipping/trackers-batch` with status `COMPLETED` (no tracking number) + read-back.
  zod schemas for every response field we use
- **Decide SDK vs own client** for Orders/Captures/Order Tracking: use `@paypal/paypal-server-sdk`
  only if it takes our token provider and its timeout/retry can match ADR 0011; otherwise our typed
  client. Record the decision and reason as a dated addendum in `docs/adr/0011-http-client-reliability.md`

Fixtures and replay (reused by M0-05/06/07):
- `fixtures/README.md`: the format. One file per exchange:
  `fixtures/<vendor>/<area>/<name>.json` = `{meta: {recorded_at, env: "sandbox", ticket, scrubbed: true},
  request: {method, url, headers (allow-list), body}, response: {status, headers (allow-list), body}}`
- `src/testing/scrub.ts`: removes `Authorization`, `access_token`, `client_secret`, cookies, and the
  OpenAI org/project headers; replaces PII (emails, names, addresses, phones, payer/merchant/account
  ids, IPs, card numbers) with stable placeholders (`payer-1@example.test`, `MERCHANT-1`); keeps ids
  PayPal needs for flow (order, capture, dispute, debug ids). Unit-tested with planted values
- `src/testing/record.ts` (recorder via `onExchange` → scrub → write) and `src/testing/replay.ts`
  (msw handlers from fixture files; unhandled requests **fail** the test)
- Spike script `scripts/spikes/paypal-a.ts` (`pnpm tsx … --record`) running the flow below once

Flow recorded under `fixtures/paypal/`: OAuth token (scrubbed) + scope list; order create+capture
(card, `custom_id = spike-<uuid>`), a repeat with the **same** `PayPal-Request-Id` (idempotent
replay); GET order; GET capture (is `custom_id` on the capture?); track with `IND_DELHIVERY`; track
with `OTHER` + `carrier_name_other`; trackers-batch `COMPLETED` + GET; error cases: 401 with a
revoked token (forced refresh path), a 400 validation error, a 404 capture.

## Out of scope

- Disputes and chargebacks (M0-05); webhooks (M0-06); OpenAI (M0-07)
- Carrier map and route advice (M3-03); guided Completed UX (M3-04); ownership table (M1-02)
- PENDING_REVIEW payments (need a browser buyer approval: M3-10)

## Acceptance Criteria

- [ ] One live run of `scripts/spikes/paypal-a.ts --record` (PAYPAL_SANDBOX claimed) writes every fixture listed above
- [ ] Replay tests prove, offline: create+capture → `COMPLETED` with `seller_receivable_breakdown`; same `PayPal-Request-Id` → same order id; track (listed + `OTHER`) → 201; trackers-batch → `COMPLETED`
- [ ] HTTP client unit tests: timeout raises `HttpTimeoutError`; retries on 503/429 (honours `Retry-After`), **not** on 400/401/404/422; breaker opens after 5 counted failures; `paypal-debug-id` surfaced
- [ ] Token provider tests: one fetch for N concurrent callers; refresh 5 min early; one forced refresh on 401
- [ ] Scrubber tests: planted token, secret, email, card number and payer id are all absent from output
- [ ] `grep` over `fixtures/` finds no credential or email outside `@example.test` (gate below)
- [ ] The SDK decision is recorded in ADR 0011 with the reason

## Deliverables

- `packages/adapters/src/http/client.ts`, `src/paypal/{token,orders,schemas}.ts`, `src/testing/{scrub,record,replay}.ts` + tests
- `scripts/spikes/paypal-a.ts`; `fixtures/README.md`; `fixtures/paypal/{oauth,orders,tracking,errors}/*.json`
- `docs/evidence/m0-04-paypal-spike-a.md` (what ran, ids, findings vs the research spike); ADR 0011 addendum

## Validation Gate

```bash
pnpm --filter @cleared/adapters test
ls fixtures/paypal/orders fixtures/paypal/tracking fixtures/paypal/errors | wc -l      # expect >= 9 files
grep -rniE '(client_secret|"access_token"\s*:\s*"A21|Bearer [A-Za-z0-9._-]{20,})' fixtures/ | wc -l   # expect 0
grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' fixtures/ | grep -vc '@example\.test$'      # expect 0
grep -rhoE '\b[0-9]{13,19}\b' fixtures/paypal | wc -l                                  # expect 0 (no card numbers)
find fixtures/paypal -name '*.json' -print0 | xargs -0 -n1 jq -e '.meta.scrubbed == true' >/dev/null && echo scrubbed-ok
./scripts/landing-checks.sh --fast
```

## Handoff

- **M0-05, M0-06:** use `client.ts`, `token.ts`, the recorder and the order/capture helper (a chargeback needs a card capture)
- **M0-07:** use the same fixture format, scrubber and replay helper for `fixtures/openai/`
- **M1-04, M2-06, M2-10, M3-03, M3-04, M3-09:** the PayPal adapter and its fixtures; replay is the default test mode
- **M0-GATE:** fixture counts and the scrub checks above
