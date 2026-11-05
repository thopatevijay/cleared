# 0011. One shared HTTP client with timeouts, retries and degradation

- Status: accepted
- Date: 2026-10-28

## Context

PayPal's server SDK defaults to no timeout; PayPal warns against re-minting tokens and excessive polling; vendors fail.

## Decision

One HTTP client in `packages/adapters`: per-vendor timeouts (PayPal 10 s, OpenAI 60 s, Resend 10 s); retries only on timeout, 5xx and 429 with jittered backoff, honouring `Retry-After`; one circuit breaker that counts only those errors; correlation-ID propagation and PayPal `debug_id` capture. One token provider (cached, refreshed 5 min before expiry) shared by the SDK and our own fetch calls. Graceful degradation: AI down → facts without a verdict; PayPal down → actions queue; email down → in-app only. Dispute-deadline watcher.

## Alternatives considered

Separate breakers per vendor and endpoint (complexity without a requirement); SDK defaults.

## Consequences

Predictable failure behaviour. Reversal cost: low.

## Addendum 2026-10-29 (M0-04): SDK vs own client for Orders, Captures and Order Tracking

**Decision: our own typed client** (`packages/adapters/src/paypal/orders.ts` on the shared
`createHttpClient`), not `@paypal/paypal-server-sdk` 2.5.0, for Orders v2, Payments v2 captures and
Orders v2 tracking. Disputes, webhooks and legacy `/v1/shipping` tracking were already ours (the SDK
does not cover them).

**Reason.** The test was "use the SDK only if it takes our token provider and its timeout/retry can
match this ADR". Token: yes (`clientCredentialsAuthCredentials.oAuthTokenProvider`). Transport: **no**.
Reading the 2.5.0 package (`dist/esm/client.js`), the `Client` constructor hard-wires
`new HttpClient(...)` from `@apimatic/axios-client-adapter`; there is no option to inject a transport.
So an SDK call cannot go through the one shared client and would bypass its circuit breaker, its
correlation-id header, its `paypal-debug-id` capture and the `onExchange` hook the fixture recorder
uses. The SDK also brings its own retry engine (`httpClientOptions.retryConfig`, apimatic
`DEFAULT_RETRY_CONFIG`), which would be a second, differently-tuned retry layer next to ours, and its
default `timeout: 0` (none). Our client for these endpoints is `orders.ts` (210 lines) plus `schemas.ts` (151
lines of zod), and the M0-04 sandbox run exercised every endpoint for real.

**Consequences.** One HTTP path for every PayPal call (recorded, replayed and broken the same way);
five fewer transitive dependencies (`@apimatic/*`, axios). We own request/response typing for the
endpoints we call; zod rejects drift at the boundary. Reversal cost: low (the client is behind
`PayPalOrdersClient`). `@paypal/paypal-server-sdk` stays listed in the project's stack list until the owner
decides to drop it; it is not installed.

**Retry details settled in M0-04.** Retries happen only on timeout, network error, 5xx and 429; a
timeout, network error or 5xx is retried only when the request is idempotent (GET, or a write
carrying `PayPal-Request-Id`); a 429 is always retried (rejected before processing). Backoff is full
jitter `random() · min(4 s, 250 ms · 2^(n-1))`, at most 2 retries; `Retry-After` (seconds or HTTP date)
replaces the backoff, and a Retry-After above 30 s fails the call instead of waiting. The breaker
opens after 5 consecutive counted failures (timeout, network error, 5xx, 429; 4xx never count),
stays open 30 s, then lets one trial call through.
