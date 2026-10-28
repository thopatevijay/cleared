# 0001. Modular monolith with two deployables

- Status: accepted
- Date: 2026-10-28

## Context

Two runtime profiles exist: request/response (UI, API, webhook ack < 500 ms) and slow or retrying work (AI runs of 30–60 s, PayPal actions with backoff, the reconcile poll). Load is small (≤ 50 sellers at launch, bursts ≤ 5/s at 100×).

## Decision

One TypeScript pnpm workspace: `apps/web` (Next.js: UI, REST API, webhook endpoint), `apps/worker` (pg-boss consumers), `packages/core` (domain: entities, invariants, state machines; no framework or I/O imports), `packages/adapters` (PayPal, OpenAI, BlobStore, PDF, email), `packages/db` (Drizzle schema, migrations, workspace-scoped repositories). Dependencies point inward.

## Alternatives considered

Microservices (no differing scale or failure profile beyond these two); a single process (slow work inside requests would break the webhook ack).

## Consequences

Two Render services instead of one. Module boundaries are enforced by package boundaries and lint rules. Reversal cost: medium.
