# 0012. Webhook ingest: verify, store raw, dedupe, enqueue

- Status: accepted
- Date: 2026-10-28

## Context

PayPal retries webhooks, doesn't guarantee order, and simulator events can't be verified through the API. A cert URL fetched blindly is an SSRF vector.

## Decision

Self-verify the signature (PayPal's documented headers) with a certificate-host allowlist (`api.paypal.com`, `api.sandbox.paypal.com`) and a cert cache; fall back to `POST /v1/notifications/verify-webhook-signature`. In one transaction: insert the raw event (unique `(provider, event_id)`) and enqueue a sync job; return 200. The job re-fetches the resource from PayPal and never trusts event order. Setup registers the webhook through the management API and uses webhook lookups.

## Alternatives considered

Check-then-insert dedupe (races under retries); processing inside the request (breaks the ack).

## Consequences

Ack < 500 ms; duplicates are harmless. Reversal cost: low.
