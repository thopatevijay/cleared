---
title: "M0-08 · Render pipeline: render.yaml Blueprint (web, worker, Postgres starter, Oregon), health checks, deploy from main, Deploy-to-Render button"
milestone: "M0 · Recon & Bootstrap"
labels: ["infra"]
blocked_by: ["M0-02"]
estimate: "3h"
resources: ["DEPLOY"]
needs: []
---

## Context

Stage One requires a **functional hosted demo**, and it must stay up until 2026-12-15 (judging
Dec 1–15). ADR 0014: a Render Blueprint (web service, background worker, managed Postgres; Oregon;
starter plans, because the free tier spins down and free Postgres expires after 30 days), a
Deploy-to-Render button for "How to run", and deploys from `main`. Getting the pipeline live in M0
means every later milestone is proven on production, not just locally (M1-07 deploys the skeleton
dashboard; M3-11 runs the storyboard there).

## Scope

- `render.yaml` (Blueprint spec checked against Render's current docs; cite the URL in the PR):
  - `web`: type web, runtime node, region `oregon`, plan `starter`, build
    `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @cleared/web build`, start
    `pnpm --filter @cleared/web start`, `healthCheckPath: /healthz`, `preDeployCommand` runs the
    Drizzle migrations (`pnpm --filter @cleared/db run migrate`), Node 24 pinned
  - `worker`: type worker, same region/plan/runtime, start `pnpm --filter @cleared/worker start`
  - `cleared-db`: Postgres, plan starter (basic-256mb or Render's current starter name), region
    `oregon`, `postgresMajorVersion` = the version recorded by M0-03
  - Env: `DATABASE_URL` `fromDatabase` (connectionString) on both services; `NODE_ENV=production`,
    `PAYPAL_ENV=sandbox`, the cap values from `.env.example`; every secret (`PAYPAL_CLIENT_ID`,
    `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `SENTRY_DSN`,
    `SESSION_SECRET`, `ENCRYPTION_KEY`) as `sync: false` (set in the dashboard, never in the file);
    `SESSION_SECRET`/`ENCRYPTION_KEY` may use `generateValue: true` if the format fits
  - Auto-deploy from `main` only after CI passes (Render's checks-pass trigger, if offered; otherwise
    auto-deploy on commit and state that in the doc)
- `apps/web`: `GET /healthz` → 200 `{ok: true, commit}` with `commit` from Render's `RENDER_GIT_COMMIT`;
  no DB call (liveness only; `/readyz` with DB + queue is M1-08)
- `apps/worker`: `start` connects to Postgres, starts pg-boss, logs one JSON `worker ready` line with
  the commit, and shuts down cleanly on SIGTERM
- README "How to run": the Deploy-to-Render button
  (`https://render.com/deploy?repo=https://github.com/thopatevijay/cleared`), noting it works once
  the repo is public and which `sync: false` values a deployer supplies
- Owner steps (console-only, from M0-00): Render payment method; connect the private GitHub repo;
  New → Blueprint → select the repo; enter the `sync: false` values. The worker prepares the exact
  list and waits; it never enters values
- Record service names, URLs and the web URL in `.dev-refs.md` (locations only) and add
  `RENDER_WEB_URL=<the public web URL>` (non-secret, **with its value**) to `.env.example`, so gates can read it without touching `.env`
- Rollback: document the Render "rollback to previous deploy" path in `docs/evidence/m0-08-render.md`

## Out of scope

- The real dashboard (M1-07); `/readyz`, Sentry and pino (M1-08)
- Registering the production PayPal webhook (M1-04, `scripts/setup.ts`)
- Load testing (M4-06); the judging runbook (M4-07)

## Acceptance Criteria

- [ ] `render.yaml` validates (Render dashboard Blueprint sync shows no errors; screenshot path in the evidence doc)
- [ ] Web, worker and Postgres exist in Oregon on starter plans (DEPLOY claimed)
- [ ] `curl $RENDER_WEB_URL/healthz` returns 200 and the `commit` equals `git rev-parse origin/main`
- [ ] A merge to `main` triggers a deploy automatically; the new commit shows on `/healthz` within 10 min (time recorded)
- [ ] The pre-deploy migration ran (Render deploy log line in the evidence doc)
- [ ] The worker log shows `worker ready` with the same commit
- [ ] No secret value in `render.yaml` (`sync: false` for each secret); `./scripts/check-no-secrets.sh` passes
- [ ] README has the Deploy-to-Render button; monthly cost matches `docs/budget.md` (≈ $20)

## Deliverables

- `render.yaml`; `apps/web` `/healthz` route; `apps/worker` start entry
- README "How to run" button; `.env.example` (`RENDER_WEB_URL`); `.dev-refs.md` (locations)
- `docs/evidence/m0-08-render.md` (services, region, plans, deploy time, rollback path)

## Validation Gate

```bash
grep -cE 'region:\s*oregon' render.yaml                                   # expect 3
grep -E '^\s*- key: (PAYPAL_CLIENT_SECRET|OPENAI_API_KEY|RESEND_API_KEY|SESSION_SECRET|ENCRYPTION_KEY)' -A1 render.yaml | grep -cE 'sync: false|generateValue: true'   # expect 5
RENDER_WEB_URL=$(grep -E '^RENDER_WEB_URL=' .env.example | cut -d= -f2-); test -n "$RENDER_WEB_URL"
curl -fsS "$RENDER_WEB_URL/healthz" | tee "$TMPDIR/healthz.json"
test "$(jq -r .commit "$TMPDIR/healthz.json")" = "$(git rev-parse origin/main)" && echo "deployed main"
pnpm --filter @cleared/web test -- healthz
./scripts/check-no-secrets.sh
```

## Handoff

- **M1-07:** deploys the skeleton dashboard through this pipeline; **M1-04:** registers the webhook at `$RENDER_WEB_URL/api/webhooks/paypal`
- **M1-08:** adds `/readyz` and observability to both services
- **M3-11, M4-06, M4-07:** production URL, rollback path, plans
- **M0-GATE:** `/healthz` reachable with the `main` commit
