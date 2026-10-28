---
title: "M1-03 · Outbox + pg-boss worker foundation (tx enqueue, idempotent consumers, backoff/DLQ, correlation ids)"
milestone: "M1 · Walking Skeleton"
labels: [backend, infra, critical]
blocked_by: [M1-02]
estimate: "4h"
resources: []
needs: []
---

## Context
Webhooks are retried and unordered, and AI and PayPal work is slow, so nothing slow runs in a request. Background work must also survive crashes without being lost or doubled (ADR 0004). The SLOs (webhook → hold visible < 2 min; approved action → PayPal 2xx < 5 min) and the "never executed twice" money guarantee depend on this foundation. It serves **Technological Implementation** and reliability.

## Scope
- **`emit(tx, event)`** in `packages/db` inserts the outbox row (topic, version, payload) and creates the pg-boss job in the **same transaction**. It uses pg-boss `send` with the `db` executor bound to `tx`. The job is keyed `singletonKey = outbox.id`
- **`enqueue(tx, queue, data, opts)`** creates the same transactional job for commands that aren't domain events (for example `paypal.capture.sync` from M1-04)
- **Job envelope (zod):** `{ messageId, correlationId, workspaceId?, data }`. `correlationId` comes from the request (or a new one) and is restored into an AsyncLocalStorage context on consume
- **Worker** (`apps/worker`):
  - boots pg-boss and creates the queues (pg-boss 12 requires `createQueue`)
  - registers handlers from one registry with concurrency 5 (architecture §12)
  - shuts down gracefully on SIGTERM (Render), finishing in-flight jobs before exit
- **Retry policy per queue:** retry limit 8, exponential backoff with jitter (pg-boss `retryBackoff`), `expireInSeconds` per queue. After the last retry the job goes to the queue's **dead-letter queue** `<queue>.dlq`. A DLQ handler logs and records the message (alerting is added in M1-08)
- **Idempotent consumer wrapper:**
  - `consume(name, handler)` inserts `consumer_receipts(consumer, messageId)` in the handler's transaction. On conflict it acks and skips; otherwise the handler's effects and the receipt commit together
  - `outbox.published_at` is set when the job is first consumed
- **Outbox relay safety net:** a job every minute re-enqueues outbox rows with no `published_at` older than 2 min (singleton per row), covering a job lost to manual DB surgery
- **Logging:** a minimal shared pino logger (`packages/adapters/src/obs/log.ts`) with a base `{service, correlationId}` binding from the context. M1-08 extends it
- Root scripts: `pnpm --filter @cleared/worker dev` and `start`

## Out of scope
- Specific consumers: capture sync → M1-04; disputes → M2-06; AI → M2-02
- Sentry, redaction, `/readyz` and the heartbeat → M1-08
- The reconcile poll (every 15 min) → M3-09
- Render worker service wiring → M1-07 (render.yaml is a hot file)

## Acceptance Criteria
- [ ] **Atomicity:** `emit` inside a transaction that then throws leaves no outbox row and no pg-boss job (integration test on compose Postgres)
- [ ] **Commit:** `emit` plus commit yields exactly one job, delivered to its handler once (test)
- [ ] **Idempotency:** the same `messageId` delivered twice runs the handler's effect once; the second delivery acks with `skipped: duplicate` (test)
- [ ] **Backoff/DLQ:** a handler that always throws, with a test retry limit of 2, lands in `<queue>.dlq` after 3 attempts, with increasing delays between attempts (test reads pg-boss job history)
- [ ] **Correlation:** a correlation ID set before `enqueue` appears in the consumer's log line (test captures pino output)
- [ ] **Shutdown:** SIGTERM during a 2 s job completes that job and exits 0 (test spawns the worker)
- [ ] **Relay:** an outbox row with no `published_at` older than 2 min is re-enqueued exactly once (test with an injected clock)
- [ ] `./scripts/landing-checks.sh --fast` passes

## Deliverables
- `packages/db/src/outbox/{emit.ts,enqueue.ts,envelope.ts,relay.ts}`
- `apps/worker/{package.json,tsconfig.json}`
- `apps/worker/src/{index.ts,boss.ts,registry.ts,consume.ts,shutdown.ts,queues.ts}`
- `packages/adapters/src/obs/{context.ts,log.ts}`
- `apps/worker/test/*.test.ts`, `packages/db/test/outbox.test.ts`

## Validation Gate
```bash
make reset
pnpm --filter @cleared/db test -- outbox 2>&1 | tee "$TMPDIR/m1-03-db.log"
pnpm --filter @cleared/worker test 2>&1 | tee "$TMPDIR/m1-03-worker.log"
pnpm --filter @cleared/worker build && (timeout 10 pnpm --filter @cleared/worker start > "$TMPDIR/m1-03-boot.log" 2>&1; true)
grep -q '"msg":"worker ready"' "$TMPDIR/m1-03-boot.log"
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-04** uses `enqueue(tx, "paypal.capture.sync", …)` in the webhook transaction and `consume()` for the sync job.
- **M1-08** extends `obs/log.ts` and adds Sentry to the DLQ handler.
- **M1-07** adds the worker service to `render.yaml`.
- **M2 and M3** consumers register via `registry.ts`.
