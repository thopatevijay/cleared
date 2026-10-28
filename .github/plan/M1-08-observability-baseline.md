---
title: "M1-08 · Observability baseline (pino + correlation, Sentry, /healthz /readyz)"
milestone: "M1 · Walking Skeleton"
labels: [infra, backend]
blocked_by: [M1-03]
estimate: "3h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-30]
---

## Context
Cleared runs unattended through judging (until 2026-12-15) with SLOs on webhook → visible, approved action → PayPal 2xx, and zero missed deadlines (ADR 0013). A failure a judge hits must be traceable from the error panel's correlation ID to the job and PayPal's `debug_id`. This supports **Technological Implementation** (production-grade operation) and the claims discipline: measured numbers come from these logs.

## Scope
- **Logger** (extends M1-03's `packages/adapters/src/obs/log.ts`):
  - pino JSON with `service` (`web` | `worker`), `env`, `release` (`RENDER_GIT_COMMIT` when present) and `correlationId` from the AsyncLocalStorage context. Level from `LOG_LEVEL`
  - **redaction** of `authorization`, `cookie`, `set-cookie`, `*.token`, `*.email`, `*.client_secret`, `access_token`, `payer.*` and `raw` webhook bodies (logged as size + sha256 only)
- **Correlation:**
  - `apps/web` request wrapper: accepts an inbound `x-correlation-id` only if it is a UUID, otherwise generates one; returns it in the response header and in every error envelope
  - jobs carry it (M1-03)
  - the shared HTTP client logs each outbound call (vendor, route template, status, duration, attempt) with the correlation ID and, for PayPal, the `paypal-debug-id` response header
- **Request log:** one line per API request (method, route template, status, duration ms). Webhook ack time is logged as `webhook_ack_ms`
- **Sentry:**
  - `@sentry/nextjs` in web (server and client; the client DSN is exposed at build from `SENTRY_DSN` via `next.config`) and `@sentry/node` in the worker
  - `sendDefaultPii: false`; `beforeSend` scrubs emails, cookies and query tokens; tags `correlationId`, `workspaceKind` (never the workspace ID or email); disabled when `SENTRY_DSN` is empty
  - captured: unhandled errors, DLQ arrivals (M1-03 DLQ handler), webhook quarantines (M1-04, as a warning) and failed verifications above 5 per 10 min
- **Health:**
  - `/healthz`: liveness, no dependencies, always 200 while the process runs
  - `/readyz` returns 200 only if all three pass, else 503 with `{checks:{db,queue,worker}}`, each check with a timeout of 2 s:
    - `db`: `select 1`
    - `queue`: the pg-boss schema is reachable
    - `worker`: a `worker_heartbeats` row is < 2 min old (the worker writes one every 30 s)
- **Docs:** `docs/runbook/observability.md`: how to follow a correlation ID through Render logs and Sentry, and what each alert means

## Out of scope
- SLO checks and the synthetic judge-path check → M3-09 (reconcile job)
- Agent run traces (`agent_runs`/`agent_steps` writes) → M2-02
- Source-map upload to Sentry → not planned (it would need a Sentry auth token; server stack traces are readable without it)
- Render health-check wiring → M1-07 (render.yaml)

## Acceptance Criteria
- [ ] **Correlation:** a request with `x-correlation-id: <uuid>` produces log lines in web, then worker (the enqueued job), then the outbound PayPal call, all with that ID and the PayPal `debug_id` (an integration test captures pino output with msw replaying a recorded capture)
- [ ] **Bad correlation ID:** a header value of `"<script>"` is replaced by a generated UUID (test)
- [ ] **Redaction:** logging an object with a cookie, a token, an email and a webhook raw body prints none of those values (test asserts on the serialised output)
- [ ] **Sentry:** with a test DSN pointed at a local capture server (msw), a thrown route error and a DLQ arrival each produce one event, tagged with `correlationId` and with no email or cookie in the payload (test)
- [ ] **Health:** `/healthz` → 200 with the DB stopped. `/readyz` → 503 with `db:false` when Postgres is stopped, 503 with `worker:false` when the worker hasn't beaten for 2 min (injected clock), and 200 when all are up (integration test plus the commands below)
- [ ] The runbook exists and names every alert source
- [ ] `./scripts/landing-checks.sh --fast` passes

## Deliverables
- `packages/adapters/src/obs/{log.ts,redact.ts,sentry.ts,http-logging.ts}`
- `apps/web/src/server/{request-context.ts,with-route.ts}`
- `apps/web/src/app/{healthz,readyz}/route.ts`, `apps/web/{sentry.server.config.ts,sentry.client.config.ts,instrumentation.ts}`
- `apps/worker/src/{heartbeat.ts,sentry.ts}`
- `docs/runbook/observability.md`, plus tests

## Validation Gate
```bash
make reset
pnpm --filter @cleared/adapters test -- obs 2>&1 | tee "$TMPDIR/m1-08-obs.log"
pnpm --filter @cleared/web test -- health correlation 2>&1 | tee "$TMPDIR/m1-08-web.log"
pnpm --filter @cleared/web build && (pnpm --filter @cleared/web start > "$TMPDIR/m1-08-web-run.log" 2>&1 &) && (pnpm --filter @cleared/worker start > "$TMPDIR/m1-08-worker.log" 2>&1 &) && sleep 40
curl -fsS localhost:3000/healthz && curl -fsS localhost:3000/readyz | tee "$TMPDIR/m1-08-ready.json"
docker compose stop postgres; curl -s -o /dev/null -w "%{http_code}" localhost:3000/readyz | grep -q 503; curl -fsS localhost:3000/healthz; docker compose start postgres
! grep -E "__Host-cleared_session=|Bearer " "$TMPDIR/m1-08-web-run.log" "$TMPDIR/m1-08-worker.log"
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-GATE** checks `/readyz` on the deployed services.
- **M2-02** logs agent runs with the same correlation ID.
- **M3-09** raises SLO and synthetic-check alerts through `sentry.ts`.
- **M4-06** reads `webhook_ack_ms` for the load-test numbers.
- **M4-07** uses the runbook.
