# M0-08 · Render pipeline

Ticket M0-08 (#10) · ADR 0014 · Blueprint: [`render.yaml`](../../render.yaml)

Sources, checked 2026-10-29:
- Blueprint spec: https://render.com/docs/blueprint-spec
- Plan names: https://render.com/docs/compute-plans
- Deploys, the "After CI Checks Pass" trigger, the pre-deploy command: https://render.com/docs/deploys
- Rollbacks: https://render.com/docs/rollbacks
- Node version: https://render.com/docs/node-version

## Services

| Resource | Blueprint name | Type | Region | Plan | Price |
|---|---|---|---|---|---|
| Web | `cleared-web` | web, runtime node | oregon | `starter` (= `0.5c-512mb`: 0.5 CPU, 512 MB) | $7/mo |
| Worker | `cleared-worker` | worker, runtime node | oregon | `starter` (= `0.5c-512mb`) | $7/mo |
| Postgres | `cleared-db` | Postgres 18, db `cleared`, user `cleared` | oregon | `basic-256mb` (= `0.1c-256mb`) | $6/mo |
| **Total** | | | | | **$20/mo**, matching `docs/budget.md` |

Render renamed its plans: `starter` and `basic-256mb` are the legacy names of `0.5c-512mb` and `0.1c-256mb`. The specs and prices are identical, and Render says the legacy names "remain valid across all Render tooling", Blueprints included. The file uses the names the ticket and the budget use.

Public web URL: _recorded after the owner creates the Blueprint (P-34)_.

## How a deploy runs

1. A commit lands on `main`. CI (`.github/workflows/ci.yml`) runs on every push to `main`.
2. `autoDeployTrigger: checksPass`: Render deploys the commit **only after all of its GitHub checks pass**. A failed check, or a commit with zero checks, does not deploy. Render's trigger exists, so the "auto-deploy on commit" fallback is not used.
3. Build: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @cleared/web build` (the worker installs only: it runs `node src/index.ts` with Node's type stripping). Node is pinned to major 24 by `NODE_VERSION=24` (and `.nvmrc`).
4. Pre-deploy (web only): `pnpm --filter @cleared/db run migrate`: the Drizzle migrations, then the pg-boss schema. It runs on a separate instance; if it fails, the whole deploy fails and the previous deploy keeps serving.
5. Start: web `pnpm --filter @cleared/web start`, health check `GET /healthz` → `200 {"ok":true,"commit":"<RENDER_GIT_COMMIT>"}` (liveness only, no DB call; `/readyz` is M1-08). Worker `pnpm --filter @cleared/worker start` connects to Postgres, starts pg-boss and logs one JSON line `{"service":"worker","msg":"worker ready","commit":"<sha>"}`. On SIGTERM it stops pg-boss gracefully (20 s bound, inside Render's 30 s shutdown delay), ends the pool, and exits 0.

Measured locally (2026-10-29, Postgres 18.6 on port 5632): the built web app answered `/healthz` with `200`, `content-type: application/json`, `cache-control: no-store`, `{"ok":true,"commit":"deadbeef"}`. The worker against the local database logged `worker ready`, `worker stopping` (`signal: SIGTERM`) and `worker stopped`, then exited 0 (`apps/worker/src/process.test.ts`).

## Environment

| Variable | Where | Source |
|---|---|---|
| `DATABASE_URL` | web, worker | `fromDatabase: cleared-db` `connectionString` (private network) |
| `NODE_VERSION`, `NODE_ENV=production`, `PAYPAL_ENV=sandbox`, `AGENT_KILL_SWITCH=false`, `OPENAI_MODEL_SMALL`, `OPENAI_MODEL_LARGE`, `LLM_DAILY_CAP_USD=1`, `LLM_WORKSPACE_CAP_USD=0.10`, `DEMO_WORKSPACES_PER_IP_PER_DAY=3`, `DEMO_WORKSPACES_GLOBAL_MAX=200`, `LOG_LEVEL=info` | group `cleared-shared` | values from `.env.example` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | group `cleared-shared` | `generateValue: true` (a base64 256-bit value; one value shared by both services) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`, `EMAIL_FROM`, `EMAIL_RECIPIENT_ALLOWLIST` | web: `sync: false`; worker: `fromService` → web | entered once by the owner in the dashboard at Blueprint creation |

Render prompts for `sync: false` values only when the Blueprint is created; a later sync ignores them. A new secret added later goes into the web service's Environment page by hand. The worker's `fromService` copies refresh on the next Blueprint sync.

## Owner steps (P-34)

_Recorded when done: date, branch, screenshot path of the Blueprint sync with no errors._

## Acceptance evidence

_Filled after the services exist: `/healthz` output against `origin/main`, the pre-deploy migration log line, the worker `worker ready` log line, the merge-to-live time._

## Rollback

Dashboard: service → **Deploys** → a recent successful deploy → **Rollback** → **Rollback to this deploy**. Render starts a new deploy from that deploy's build artifact (no rebuild).

- A dashboard rollback **turns auto-deploy off** for that service. Turn it back on in the service's **Settings** (auto-deploy: After CI Checks Pass) once `main` is fixed. Rolling back through the API leaves auto-deploy on.
- Roll back the web and the worker together, so both run the same commit.
- Migrations are forward-only (ADR 0002) and a rollback does not undo them: the older code must tolerate the newer schema. Fix forward with a new migration; never edit an applied one.
- Only deploys whose build artifact Render still keeps can be restored (the count depends on the workspace plan).
- Postgres is not rolled back. To recover data, use the database's **Recovery** page (point-in-time recovery or an export, as the plan offers; not verified for `basic-256mb` yet).
