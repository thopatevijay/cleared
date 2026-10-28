---
title: "M0-06 · PayPal spike C: webhook register/list via API, self-verify signature (cert allowlist), simulator, real deliveries via a tunnel; fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "backend", "security"]
blocked_by: ["M0-04"]
estimate: "3h"
resources: ["PAYPAL_SANDBOX"]
needs: [P-01, P-02, P-03, P-05, P-08, P-10, P-21, P-46]
---

## Context

"A payment arrives (webhook)" is step 1 of the core journey and the M1 gate. ADR 0012 commits to
**self-verifying** PayPal signatures with a certificate-host allowlist (SSRF guard), falling back to
the verify API, and acking after a raw insert (< 500 ms). None of that has been run yet: the
research spike never received a webhook. Webhooks are **app-scoped** and simulator events can't be
verified by the postback API, so we need real, signed deliveries recorded exactly as received.
Spoofed webhooks are the first STRIDE row (`docs/architecture.md` §8): Technological Implementation and security.

Prior evidence (read first): `~/hackathons/.research/paypal-ai-hackathon/notes/kickoff/paypal-integration.md`
§1 (event names, delivery semantics, signature string `transmissionId|timeStamp|webhookId|crc32`,
SHA256withRSA, simulator `WEBHOOK_ID`, management API, webhooks-lookup).

## Scope

Product code (`packages/adapters/src/paypal/`, on the shared HTTP client):
- `webhooks.ts`: `listWebhooks`, `ensureWebhook(url, eventTypes)` (list → create if missing →
  PATCH event types if they differ; idempotent), `deleteWebhook`, `ensureWebhookLookup`,
  `simulateEvent`, `listWebhookEvents` (replay/back-fill), `verifyViaApi`
- `webhook-verify.ts`: `verifyWebhook({rawBody, headers, webhookId})`: CRC32 of the **raw** body
  (`node:zlib` `crc32`), the signed string, SHA256withRSA against the cert from `paypal-cert-url`.
  The cert URL must be `https:` on host `api.paypal.com` or `api.sandbox.paypal.com` (exact match,
  no redirects followed), fetched through the shared client, cached by URL with its validity dates
  checked. Rejects: unknown host, http, IP literal, missing header, stale transmission time (> 5 min skew)
- Event types: `PAYMENT.CAPTURE.{COMPLETED,PENDING,DENIED,DECLINED,REVERSED,REFUNDED}`,
  `CUSTOMER.DISPUTE.{CREATED,UPDATED,RESOLVED}`

Spike (`scripts/spikes/paypal-c.ts`, `scripts/spikes/webhook-receiver.ts`):
- A throwaway local receiver (Node `http`) that writes each delivery's raw body (bytes, untouched)
  and all `paypal-*` headers to `$TMPDIR/m0-06/`, then returns 200. Not the product route (M1-04)
- A `cloudflared` quick tunnel (no account; install via Homebrew if missing) exposes it on HTTPS 443
- Register a **temporary** spike webhook on the tunnel URL with `ensureWebhook`, add a webhook
  lookup, then trigger real events: a card capture (M0-04 helper) and a chargeback (M0-05 helper).
  Record delivery latency. Then fire one simulator event per type. Delete the spike webhook at the end
  (the app's real webhook is registered in M1-04 against the Render URL; ≤ 10 per app)
- Fixtures (delivery files use `{meta, event_type, headers, raw_body}` with `raw_body` as the exact
  string received; documented in `fixtures/README.md`):
  - `fixtures/paypal/webhooks/management/*.json`: list/create/patch/lookup/simulate/events responses (scrubbed)
  - `fixtures/paypal/webhooks/simulator/*.json`: simulator deliveries **kept byte-for-byte**
    (PayPal sample data, no personal data; signed with webhook id `WEBHOOK_ID`) plus the public
    cert as a string field, so a replay test verifies a **real PayPal signature** offline
  - `fixtures/paypal/webhooks/deliveries/*.json`: real deliveries **scrubbed** (PII removed breaks
    the signature), so their verify test re-signs with a key pair generated at test runtime (never
    stored); the live verification result (`SUCCESS` via self-verify **and** via the API) is
    recorded in the evidence doc per delivery
- Measure: self-verify time with a warm cert cache

## Out of scope

- The product webhook route, raw insert, dedupe and enqueue (M1-04)
- `scripts/setup.ts` registration against the Render URL and `PAYPAL_WEBHOOK_ID` for production (M1-04 / M0-08)
- Reconcile poll (M3-09)

## Acceptance Criteria

- [ ] Live (PAYPAL_SANDBOX claimed): at least one real `PAYMENT.CAPTURE.COMPLETED` and one `CUSTOMER.DISPUTE.CREATED` delivered through the tunnel; self-verify and the verify API both return valid for each (recorded)
- [ ] `ensureWebhook` run twice creates one webhook (second run is a no-op); the spike webhook is deleted at the end (`listWebhooks` shows it gone)
- [ ] Replay test: a simulator fixture verifies with its real signature offline; flipping one body byte fails it
- [ ] Re-signed delivery fixtures verify; wrong webhook id, stale time and tampered body fail
- [ ] Cert host allowlist tests: `http://`, `api.paypal.com.evil.test`, an IP literal, a redirect and `localhost` are rejected **without** a network call
- [ ] Measured: delivery latency per event and warm self-verify time (< 50 ms) in `docs/evidence/m0-06-paypal-spike-c.md`
- [ ] Scrub checks pass on `fixtures/paypal/webhooks/deliveries/` and `management/`

## Deliverables

- `packages/adapters/src/paypal/{webhooks,webhook-verify}.ts` + tests
- `scripts/spikes/{paypal-c,webhook-receiver}.ts`
- `fixtures/paypal/webhooks/{management,simulator,deliveries}/*.json`
- `docs/evidence/m0-06-paypal-spike-c.md`

## Validation Gate

```bash
pnpm --filter @cleared/adapters test -- webhook
find fixtures/paypal/webhooks/simulator -name '*.json' | wc -l        # expect >= 1
find fixtures/paypal/webhooks/deliveries -name '*.json' | wc -l       # expect >= 2
find fixtures/paypal/webhooks/deliveries -name '*.json' -exec jq -r '.event_type' {} \; | sort -u   # expect the capture and dispute types
grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' fixtures/paypal/webhooks/deliveries fixtures/paypal/webhooks/management | grep -vc '@example\.test$'   # expect 0
grep -rlE 'PRIVATE KEY' fixtures/ | wc -l                             # expect 0 (test keys are generated at runtime)
./scripts/landing-checks.sh --fast
```

## Handoff

- **M1-04:** `verifyWebhook` and `ensureWebhook`/`ensureWebhookLookup` as-is; the delivery fixtures drive the ingest tests; the measured latency sets the "webhook → visible" expectation
- **M3-09:** `listWebhookEvents` for back-fill alongside the reconcile poll
- **M4-05:** the allowlist tests are part of the security review
- **M0-08:** none directly; the production webhook URL is `<render web URL>/api/webhooks/paypal`
