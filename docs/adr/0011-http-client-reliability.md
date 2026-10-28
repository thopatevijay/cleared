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
