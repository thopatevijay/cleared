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
| **Total** | | | | | **$20/mo**, matching the project budget |

Render renamed its plans: `starter` and `basic-256mb` are the legacy names of `0.5c-512mb` and `0.1c-256mb`. The specs and prices are identical, and Render says the legacy names "remain valid across all Render tooling", Blueprints included. The file uses the names the ticket and the budget use.

Public web URL: **https://cleared-web-gd1b.onrender.com** (`RENDER_WEB_URL` in `.env.example`).

Live resources, as listed by the Render CLI (v2.33.0, read-only `render services list` / `render deploys list`, 2026-10-29):

| Resource | Render id | Type | Region | Plan |
|---|---|---|---|---|
| `cleared-web` | `srv-dbheesg473hc739p3g0g` | web_service | oregon | starter |
| `cleared-worker` | `srv-dbhehn0473hc739paf3g` | background_worker | oregon | starter |
| `cleared-db` | `dpg-dbheefg473hc739p28u0-a` | postgres 18 | oregon | basic_256mb |

Blueprint `exs-dbhe9c61egvs73fb9su0`, repo `thopatevijay/cleared`, branch `main`.

## How a deploy runs

1. A commit lands on `main`. CI (`.github/workflows/ci.yml`) runs on every push to `main`.
2. `autoDeployTrigger: checksPass`: Render deploys the commit **only after all of its GitHub checks pass**. A failed check, or a commit with zero checks, does not deploy. Render's trigger exists, so the "auto-deploy on commit" fallback is not used.
3. Build: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @cleared/web build` (the worker installs only: it runs `node src/index.ts` with Node's type stripping). Node is pinned to major 24 by `NODE_VERSION=24` (and `.nvmrc`).
4. Pre-deploy (web only): `pnpm --filter @cleared/db run migrate`: the Drizzle migrations, then the pg-boss schema. It runs on a separate instance; if it fails, the whole deploy fails and the previous deploy keeps serving.
5. Start: web `pnpm --filter @cleared/web start`, health check `GET /healthz` → `200 {"ok":true,"commit":"<RENDER_GIT_COMMIT>"}` (liveness only, no DB call; `/readyz` is M1-08). Worker `pnpm --filter @cleared/worker start` connects to Postgres, starts pg-boss and logs one JSON line `{"service":"worker","msg":"worker ready","commit":"<sha>"}`. On SIGTERM it stops pg-boss gracefully (20 s bound, inside Render's 30 s shutdown delay), ends the pool, and exits 0.

Measured locally (2026-10-29, Postgres 18.6 on port 5632): the built web app answered `/healthz` with `200`, `content-type: application/json`, `cache-control: no-store`, `{"ok":true,"commit":"deadbeef"}`. The worker against the local database logged `worker ready`, `worker stopping` (`signal: SIGTERM`) and `worker stopped`, then exited 0 (`process.test.ts` at the time; M1-03 replaced it with `apps/worker/test/shutdown.test.ts`).

## Environment

| Variable | Where | Source |
|---|---|---|
| `DATABASE_URL` | web, worker | `fromDatabase: cleared-db` `connectionString` (private network) |
| `NODE_VERSION`, `NODE_ENV=production`, `PAYPAL_ENV=sandbox`, `AGENT_KILL_SWITCH=false`, `OPENAI_MODEL_SMALL`, `OPENAI_MODEL_LARGE`, `LLM_DAILY_CAP_USD=1`, `LLM_WORKSPACE_CAP_USD=0.10`, `DEMO_WORKSPACES_PER_IP_PER_DAY=3`, `DEMO_WORKSPACES_GLOBAL_MAX=200`, `LOG_LEVEL=info` | group `cleared-shared` | values from `.env.example` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | group `cleared-shared` | `generateValue: true` (a base64 256-bit value; one value shared by both services) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`, `EMAIL_FROM`, `EMAIL_RECIPIENT_ALLOWLIST` | web: `sync: false`; worker: `fromService` → web for all except `PAYPAL_WEBHOOK_ID` (web-only) | entered once by the owner in the dashboard at Blueprint creation |

**Pitfall (first Blueprint creation, 2026-10-29):** `PAYPAL_WEBHOOK_ID` was left blank (M1-04 creates the webhook), so Render never created it on `cleared-web`, and the worker's `fromService … envVarKey: PAYPAL_WEBHOOK_ID` failed the Blueprint with `environment variable not found: "PAYPAL_WEBHOOK_ID" for cleared-web`. A `fromService` reference fails Blueprint creation when the source variable is empty; the worker now references only the 7 variables that always have a value.

Render prompts for `sync: false` values only when the Blueprint is created; a later sync ignores them. A new secret added later goes into the web service's Environment page by hand. The worker's `fromService` copies refresh on the next Blueprint sync.

## Owner steps (P-34)

2026-10-29, done by the owner in the dashboard: New → Blueprint → `thopatevijay/cleared`, branch `main` → entered the `sync: false` values → Apply.

1. The first creation (from `e4b1c12`) failed while creating the worker: `environment variable not found: "PAYPAL_WEBHOOK_ID" for cleared-web` (see the pitfall above). It was fixed in #75 (`f40148a`).
2. The owner ran **Manual Sync** on `f40148a`. All 3 resources were created and the sync showed no errors.

**No screenshot was taken.** The Render CLI listing above (all 3 resources present, each with a live deploy) is the record that the Blueprint synced without errors. Validation before creation: `render.yaml` passes Render's JSON schema (https://render.com/schema/render.yaml.json, ajv 8, draft 2020-12), and a bogus plan value is rejected by the same check.

## Acceptance evidence

**`/healthz`** (2026-10-29, before this PR merged; `origin/main` = `f40148a`):

```
$ curl -fsS https://cleared-web-gd1b.onrender.com/healthz
{"ok":true,"commit":"f40148a932630c9b36e7156f56eb7b08e2c04c24"}
```

**Pre-deploy migration** (web deploy `dep-dbheib2vcj2c738035eg`, from `render logs -r srv-dbheesg473hc739p3g0g`):

```
2026-10-29 06:35:58  ==> Build successful 🎉
2026-10-29 06:36:00  ==> Starting pre-deploy: pnpm --filter @cleared/db run migrate
2026-10-29 06:36:16  {"service":"db","msg":"migrations applied","applied":1,"queueSchema":"pgboss"}
```

The same lines appear for the two earlier deploys (06:28:53 and 06:33:52), so a re-run is a no-op.

**Worker** (deploy `dep-dbheib2vcj2c7380356g`, from `render logs -r srv-dbhehn0473hc739paf3g`):

```
2026-10-29 06:36:13  $ node src/index.ts
2026-10-29 06:36:15  {"service":"worker","msg":"worker ready","commit":"f40148a932630c9b36e7156f56eb7b08e2c04c24"}
```

Node on Render: `Using Node.js version 24.22.2 via environment variable NODE_VERSION`. pnpm: `v12.15.0` (Corepack).

**Merge → live, with the checksPass trigger** (times from `gh pr view --json mergedAt`, `gh run list`, and `render deploys list -o json`):

| Commit | Merged to `main` | CI on `main` finished (success) | Render deploy created | Web live | Merge → live |
|---|---|---|---|---|---|
| `8deb5b9` (#74) | 06:31:45Z | 06:33:05Z (run 40829756882) | 06:33:08Z | 06:34:34Z | **2 min 49 s** |
| `f40148a` (#75) | 06:33:59Z | 06:35:22Z (run 40829982783; landing checks completed 06:35:21Z) | 06:35:24Z | 06:36:47Z | **2 min 48 s** |

Both deploys started 2–3 s after the last CI check passed, never before it. This is the checksPass trigger at work; Render labels the trigger `new_commit`. Both are well inside the 10-minute bound. The worker deploy of `f40148a` was live at 06:36:09Z.

## Rollback

Dashboard: service → **Deploys** → a recent successful deploy → **Rollback** → **Rollback to this deploy**. Render starts a new deploy from that deploy's build artifact (no rebuild).

- A dashboard rollback **turns auto-deploy off** for that service. Turn it back on in the service's **Settings** (auto-deploy: After CI Checks Pass) once `main` is fixed. Rolling back through the API leaves auto-deploy on.
- Roll back the web and the worker together, so both run the same commit.
- Migrations are forward-only (ADR 0002) and a rollback does not undo them: the older code must tolerate the newer schema. Fix forward with a new migration; never edit an applied one.
- Only deploys whose build artifact Render still keeps can be restored (the count depends on the workspace plan).
- Postgres is not rolled back. To recover data, use the database's **Recovery** page (point-in-time recovery or an export, as the plan offers; not verified for `basic-256mb` yet).
