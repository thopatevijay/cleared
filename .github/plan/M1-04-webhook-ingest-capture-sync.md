---
title: "M1-04 · Webhook ingest (self-verify, raw store, dedupe, enqueue) + capture sync job"
milestone: "M1 · Walking Skeleton"
labels: [backend, security, critical, blocker-risk]
blocked_by: [M1-03]
estimate: "4h"
resources: [PAYPAL_SANDBOX]
needs: []
---

## Context
PayPal's webhooks are the start of the core journey (a payment arrives) and of the SLO "webhook → hold visible < 2 min". Three risks drive the design:
- A cert URL fetched blindly is an SSRF vector (B6 #13)
- PayPal retries webhooks and doesn't order them
- Every demo workspace shares one merchant, so an unowned capture must never land in someone's workspace (B6 #1, ADR 0008)

Getting this right is core **Technological Implementation** (real Webhooks + Payments APIs) and the security story.

## Scope
- **Route** `POST /api/webhooks/paypal` (`apps/web`, Node runtime):
  - reads the **raw body** (1 MB cap) before parsing
  - zod-parses the envelope (`id`, `event_type`, `resource_type`, `resource`, `create_time`, `resource_version`)
- **Self-verify** (ADR 0012) reuses M0-06's `verifyWebhook({rawBody, headers, webhookId: PAYPAL_WEBHOOK_ID})`. That function already provides the raw-body CRC32, SHA256withRSA, the exact-host cert allowlist (`api.paypal.com` / `api.sandbox.paypal.com`, `https:`, no redirects, no IP literals) via the shared HTTP client, the cert cache and the 5-minute skew check. This ticket adds:
  - in the sandbox env, only the sandbox cert host is accepted
  - **Fallback:** if self-verify is inconclusive (cert fetch failed or timed out, unknown `PAYPAL-AUTH-ALGO`), M0-06 `verifyViaApi` (`POST /v1/notifications/verify-webhook-signature`)
  - on rejection → 401, nothing stored, a warning logged with the transmission ID only
- **Webhook registration:** `scripts/setup.ts` (idempotent; M0-06 `ensureWebhook` + `ensureWebhookLookup`) registers the app's real webhook at `$RENDER_WEB_URL/api/webhooks/paypal` for the M0-06 event types. It prints the webhook ID for the owner to put in the Render env and `.env` as `PAYPAL_WEBHOOK_ID`; the value is never committed
- **One transaction** (via M1-03 `tx`):
  - insert into `webhook_events` (`provider='paypal'`, `event_id`, type, raw jsonb, `verified=true`, `status='received'`, `correlation_id`) with `ON CONFLICT (provider,event_id) DO NOTHING`
  - if inserted and routable, `enqueue(tx, "paypal.capture.sync", { captureId, eventId })`
  - return 200. A duplicate returns 200 with no new job. No PayPal fetch happens inside the request
- **Routing:**
  - `PAYMENT.CAPTURE.*` (COMPLETED, PENDING, DENIED, DECLINED, REFUNDED, REVERSED) → capture sync. The capture ID is `resource.id`, or for refund and reversal resources the `rel=up` link
  - `CUSTOMER.DISPUTE.*` and `CHECKOUT.ORDER.*` are stored raw with `status='received'`; M2-06 adds their routing and backfills from stored rows
- **Capture sync consumer** (`apps/worker`, idempotent via `consume()`):
  - `GET /v2/payments/captures/{id}` through the M0-04 token provider and shared client, zod-parsed. Reads `supplementary_data.related_ids.order_id`, `custom_id`, `status`, `status_details.reason`, `seller_receivable_breakdown`
  - Ownership via `resolveOwner` (M1-01):
    - `owned` → in one transaction: upsert `paypal_resource_owner(capture)` (inherit), upsert the `payments` mirror with `applyMirror`, set `source='webhook'` and `synced_at`, `emit` `payment.captured` on first insert or `payment.status_changed` on a change, and mark the event `processed`
    - `unowned` → retry with backoff for up to 10 min (covers the race with order creation), then `quarantined` plus an `audit_log` row
    - `mismatch` (custom_id ≠ owner) → `quarantined` immediately and audited
- **Sandbox test-payment creator:**
  - adapter `createOwnedTestPayment(workspaceId)`: the M0-04 card order + capture flow, `custom_id = workspace_id`, `PayPal-Request-Id` = job messageId. The owner row is inserted after order create and **before** capture
  - job `sandbox.test_payment` and a CLI `pnpm --filter @cleared/worker sandbox:pay -- --workspace <id>`
  - M1-07 adds the UI trigger

## Out of scope
- The verify primitives, cert allowlist and management API client → M0-06 (reused here)
- Dispute sync → M2-06; reconcile poll → M3-09
- Hold derivation and UI → M3-01
- The judge scenario (chargeback, labelled sandbox decision) → M2-10
- Sentry alerts for quarantines → M1-08

## Acceptance Criteria
- [ ] **Fixture replay through the route (CI):**
  - each `fixtures/paypal/webhooks/simulator/*.json` delivery (real PayPal signature, clock injected to its transmission time, msw serving its cert) → 200 and one row
  - each `deliveries/*.json` delivery, re-signed at test runtime per M0-06, → 200
- [ ] **Tampering at the route:** one changed byte in the body, a wrong webhook ID or a stale transmission time → 401 and no row (tests)
- [ ] **Fallback:** a cert fetch timeout triggers `verifyViaApi` (msw replaying the M0-06 management fixture); `FAILURE` → 401 (tests)
- [ ] **SSRF at the route:** a delivery whose cert URL is `http:`, `api.paypal.com.evil.example`, an IP literal or a redirect → 401 with no outbound request (msw asserts)
- [ ] **Setup:** `scripts/setup.ts` run twice leaves exactly one webhook for the Render URL (management fixture replay test; live run recorded in the PR)
- [ ] **Dedupe:** the same delivery posted 5 times concurrently yields 1 row and 1 job, and all 5 responses are 200 (integration test)
- [ ] **Ack time:** p95 < 500 ms over 50 fixture posts against local web (`autocannon` or a vitest loop; the number is recorded in the PR)
- [ ] **Sync (fixture replay):** the recorded `GET capture` responses produce a payment row whose status and reason match the fixture. Replaying an older `update_time` changes nothing, and running sync twice emits one event (tests)
- [ ] **Ownership:** a capture with no owner row ends `quarantined` after the retry window (injected clock); a mismatched custom_id is quarantined immediately; both write audit rows (tests)
- [ ] **Live proof (PAYPAL_SANDBOX):**
  - with a **temporary** webhook on a `cloudflared` quick tunnel to the local web (M0-06 method; the local web runs with that webhook's ID in its shell env only), `sandbox:pay` creates a real card capture
  - its real `PAYMENT.CAPTURE.COMPLETED` delivery is self-verified and ingested, and the payment row appears with `source='webhook'` within 2 min
  - the temporary webhook is deleted afterwards (`listWebhooks` shows only the Render one)
  - the capture GET response is recorded under `fixtures/paypal/orders/` (alongside the M0-04 capture GETs), scrubbed per `fixtures/README.md`
- [ ] `./scripts/landing-checks.sh --fast` passes

## Deliverables
- `apps/web/src/app/api/webhooks/paypal/route.ts`
- `packages/adapters/src/paypal/{webhook-ingest.ts,captures.ts,test-payment.ts}`, `scripts/setup.ts`
- `apps/worker/src/jobs/{capture-sync.ts,test-payment.ts}`, `apps/worker/src/cli/sandbox-pay.ts`
- tests under `apps/web/test/webhooks/`, `packages/adapters/test/paypal/` and `apps/worker/test/jobs/`
- new fixture(s) under `fixtures/paypal/orders/` (alongside the M0-04 capture GETs)

## Validation Gate
```bash
make reset && pnpm --filter @cleared/db run seed
pnpm --filter @cleared/adapters test -- paypal 2>&1 | tee "$TMPDIR/m1-04-adapters.log"
pnpm --filter @cleared/web test -- webhooks 2>&1 | tee "$TMPDIR/m1-04-web.log"
pnpm --filter @cleared/worker test -- capture-sync 2>&1 | tee "$TMPDIR/m1-04-worker.log"
# live proof (PAYPAL_SANDBOX claimed): cloudflared tunnel + temporary webhook up, web + worker running locally
WS=$(psql "$DATABASE_URL" -Atc "select id from workspaces limit 1")
pnpm --filter @cleared/worker sandbox:pay -- --workspace "$WS" | tee "$TMPDIR/m1-04-live.log"
for i in $(seq 1 24); do psql "$DATABASE_URL" -Atc "select count(*) from payments where workspace_id='$WS' and source='webhook'" | grep -qv '^0$' && break; sleep 5; done
psql "$DATABASE_URL" -Atc "select status from payments where workspace_id='$WS'" | grep -q COMPLETED
pnpm tsx scripts/setup.ts --list-webhooks | tee "$TMPDIR/m1-04-webhooks.txt"   # only the Render URL remains
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-07** calls `sandbox.test_payment` from the UI and lists the `payments` rows.
- **M1-GATE** repeats the live path on the deployed services.
- **M2-06** adds dispute routing on stored `CUSTOMER.DISPUTE.*` rows.
- **M2-10** reuses `createOwnedTestPayment`.
- **M1-08** adds a Sentry alert on quarantine.
