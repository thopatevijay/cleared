# 0003. REST API with shared zod contracts

- Status: accepted
- Date: 2026-10-28

## Context

One first-party web client; PayPal and judges may retry; mutating calls must be safe to repeat.

## Decision

REST JSON route handlers in Next.js; zod schemas in `packages/core` shared by client and server; one error envelope `{error:{code,message,details,correlationId}}`; an `Idempotency-Key` header required on every mutating route (stored in `idempotency_keys`); offset pagination; rate limits per session and per IP.

## Alternatives considered

GraphQL or tRPC (a single client gains little from either); cursor pagination (lists are small).

## Consequences

Simple, typed contracts. Reversal cost: low.
