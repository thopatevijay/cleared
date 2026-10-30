# Runbook: observability

How to trace a failure from what a judge sees to the job and PayPal's `debug_id`, and what each alert means. Built in M1-08; M4-07 uses it for operations through 2026-12-15.

## What is logged

Every service writes one JSON line per event to stdout (pino). Render keeps those lines in each service's **Logs** tab.

| Field | Meaning |
|---|---|
| `service` | `web` or `worker` |
| `env` | `NODE_ENV` (`production` on Render) |
| `release` | the deployed git commit (`RENDER_GIT_COMMIT`); absent locally |
| `correlationId` | one id per causal chain: request, then job, then outbound call |
| `messageId`, `workspaceId` | set on worker lines for the job being consumed |
| `level` | `debug`, `info`, `warn`, `error` (`LOG_LEVEL`, default `info`) |

Line types to search for:

| `msg` | Where | Fields |
|---|---|---|
| `request` | web, one per API request | `method`, `route` (template, e.g. `/api/demo`), `status`, `durationMs`; webhook routes also `webhook_ack_ms` |
| `request failed` | web, an unhandled error (then a 500 envelope) | `route`, `method`, `err` |
| `message consumed` / `message skipped: duplicate` / `message failed` | worker | `queue`, `jobId`, `attempt` |
| `message dead-lettered` | worker, retries exhausted | `queue`, `dlq`, `messageId`, `sourceId` |
| `outbound call` / `outbound call failed` | web or worker, one per HTTP attempt | `vendor`, `method`, `route` (ids replaced by `:id`), `status` or `failure` (`timeout`/`network`), `durationMs`, `attempt`, `paypalDebugId` |
| `worker heartbeat failed` | worker | `workerId`, `error` |
| `outbox relay re-sent unpublished rows` | worker, every minute when needed | `stale`, `enqueued`, `failed` |

`/healthz` and `/readyz` log their `request` line at `debug`, so Render's health checks don't flood the logs.

### What is never logged

Redaction runs on every line and every Sentry event (`packages/adapters/src/obs/redact.ts`), at any depth:

- **Keys whose value is replaced by `[Redacted]`:** `authorization`, `cookie`, `set-cookie`, any `*token`, `*secret`, `*password`, `*email`, `client_secret`, `access_token`, and `payer` with everything under it.
- **`raw`** (a webhook body) is replaced by `{ size, sha256 }`. The sha256 matches the stored `webhook_events` row.
- **Free text** (messages, error messages, stack traces) has email addresses replaced by `[email]`, `Bearer …`/`Basic …` credentials by `[credential]` and `__Host-…=` cookie pairs by `[cookie]`.

If a secret ever shows in Render logs, treat it as leaked: rotate it (`docs/PREREQS.md`), then log the gap to BL-01.

## Following a correlation ID

1. **Get the id.**
   - From the UI: every API error envelope carries `error.correlationId` (ADR 0003), and the error panel shows it.
   - From a response: the `x-correlation-id` header, which is on every API response.
   - A caller may send its own `x-correlation-id`. It is kept only when it is a UUID; anything else is replaced by a new UUID.
2. **Web side.** In Render, open `cleared-web` → Logs, and search for the id. You get the `request` line (route, status, duration) and anything the handler logged. A `request failed` line has the error.
3. **Worker side.** Open `cleared-worker` → Logs and search for the same id. The job envelope carried it, so you get `message consumed` or `message failed` with `queue`, `jobId` and `attempt`, and every line the handler wrote.
4. **PayPal side.** The `outbound call` lines with that id carry `paypalDebugId`. Quote that value to PayPal (merchant technical support) to find the call on their side.
5. **Sentry.** Search `correlationId:<id>` (it is a tag on every event). Events also carry `service` (`web`, `worker`, `web-client`) and, when known, `workspaceKind` (`seller`/`demo`). Workspace ids and emails are never sent.

Local equivalent: `pnpm --filter @cleared/web start | grep <id>` and the same for the worker.

## Health endpoints

| Endpoint | Meaning | Use |
|---|---|---|
| `GET /healthz` | Liveness. No dependencies, always `200 {"ok":true,"commit":…}` while the process runs | Render's health check (`healthCheckPath`) |
| `GET /readyz` | Readiness. `200` only if all three checks pass, else `503`. Body `{"ok":bool,"checks":{"db":bool,"queue":bool,"worker":bool}}` | Gates (M1-GATE), smoke checks, a person checking the system |

`/readyz` checks run in parallel, and each has a 2 s timeout:

- **`db`:** `select 1` on the web's pool.
- **`queue`:** the pg-boss schema is reachable (`select version from pgboss.version`).
- **`worker`:** the newest `worker_heartbeats.beat_at` is under 2 minutes old. Each worker process upserts its row at start and every 30 s (`workerId` is `RENDER_INSTANCE_ID`, or host:pid locally).

**Why Render's health check stays on `/healthz`.** Render uses the health check to decide whether a new web deploy goes live and whether to restart the instance. If it used `/readyz`, a stopped worker or a database blip would block or roll back web deploys and restart a healthy web process, which fixes nothing. `/readyz` is for diagnosis, not for routing.

Reading a 503:

| `checks` | Likely cause | First step |
|---|---|---|
| `db:false, queue:false, worker:false` | Postgres unreachable from web | Render → `cleared-db` status; web logs for `idle client error` |
| `db:true, queue:false` | pg-boss schema missing (migrate did not run) | Check the web deploy's pre-deploy (`migrate`) log |
| `db:true, queue:true, worker:false` | Worker down, crashing or stuck for 2+ min | `cleared-worker` → Logs (`start failed`, `worker stopping`), then Events; redeploy or restart it |

## Alerts (Sentry)

One Sentry project serves web and worker; filter by the `service` tag. Without `SENTRY_DSN`, nothing is sent: the SDK is disabled and the reporting functions do nothing. The SDK collects no user info, cookies, request bodies, query strings, queue payloads, database data or local variables (`dataCollection` in `packages/adapters/src/obs/sentry.ts`). Every event also passes through `beforeSend` (`scrubEvent`).

| Alert | Level | Source | What it means | What to do |
|---|---|---|---|---|
| Unhandled route error | error | web, `withRoute` (`apps/web/src/server/with-route.ts`); errors outside `withRoute` via `onRequestError` (`apps/web/instrumentation.ts`) | An API request threw; the user got a 500 envelope with the correlation id | Follow the correlation id; fix, or log it to BL-01 |
| Browser error | error | web client (`apps/web/sentry.client.config.ts`), tag `service:web-client` | A page threw in the browser | Reproduce on the same route |
| Unhandled worker error | error | worker, `@sentry/node` default handlers (uncaught exception, unhandled rejection) | The worker process hit an error outside a job | Check worker logs around the event; Render restarts a crashed worker |
| `message dead-lettered: <queue>` | error | worker, `deadLetterHandler` (`apps/worker/src/boss.ts`) | A job failed every retry (8, with backoff up to 300 s) and is in `<queue>.dlq` | Follow the correlation id to the failing attempts (`message failed` lines with the error); fix the cause, then re-send if the action is still valid |
| `webhook quarantined: <reason>` | warning | `reportQuarantine` (M1-04 webhook processing) | A PayPal webhook was for a resource with no owner workspace, so it was kept but not applied | Expected for payments made outside Cleared's app; otherwise check `paypal_resource_owner` |
| `webhook verification failures above 5 per 10 min` | warning | `verificationFailureAlert.record()` (M1-04, on each failed verification) | Someone is posting unverifiable webhooks, or `PAYPAL_WEBHOOK_ID` is wrong after a webhook re-registration | Check `PAYPAL_WEBHOOK_ID` on `cleared-web` against the PayPal app's webhook; a burst from one source is noise |
| SLO and synthetic-check alerts | warning | M3-09 (reconcile job), through `reportWarning` | An SLO from ADR 0013 was breached | Per M3-09's notes |

The verification-failure counter is per process, so with one web instance it counts every failure. Its window is 10 minutes. After it fires it stays quiet for one window.

## Configuration

| Variable | Where | Effect |
|---|---|---|
| `SENTRY_DSN` | Render `cleared-web` (secret), worker via `fromService` | Enables Sentry; also exposed to the browser at build as `NEXT_PUBLIC_SENTRY_DSN` (`next.config.ts`), so a DSN change needs a web rebuild |
| `LOG_LEVEL` | env group `cleared-shared` | pino level (`info` default; `debug` shows the health probes' request lines) |
| `RENDER_GIT_COMMIT` | set by Render | `release` on log lines and Sentry events |

Source maps are not uploaded (that would need a Sentry auth token), so browser stack traces are minified. Server stack traces are readable as they are.
