# 0004. pg-boss queue with a transactional outbox

- Status: accepted
- Date: 2026-10-28

## Context

Webhooks are app-scoped, retried by PayPal up to 25 times over 3 days, and not ordered. Background work must not be lost or duplicated.

## Decision

pg-boss in the same Postgres. Jobs and outbox rows are inserted in the same transaction as the state change. Consumers are idempotent (keyed by PayPal IDs and outbox IDs), with exponential backoff + jitter and a dead-letter queue. Events carry a `version`. A reconcile job (every 15 min) re-fetches known open payments and disputes, runs the SLO checks and the synthetic judge-path check. The UI polls every 5 s.

## Alternatives considered

Redis/BullMQ (an extra store); Render Workflows (public beta); graphile-worker (0.x, at-least-once only); websockets/SSE (polling meets the latency requirement).

## Consequences

Exactly-once *effect* via idempotency on an at-least-once queue. Reversal cost: medium.
