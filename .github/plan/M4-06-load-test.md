---
title: "M4-06 · Load test (launch + 100× webhook burst)"
milestone: "M4 · Trust & Global"
labels: ["infra", "backend"]
blocked_by: ["M3-GATE"]
estimate: "3h"
resources: ["DEPLOY"]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-14, P-35, P-46]
---

## Context

Architecture §1 sets assumed load figures (launch: ≤ 20 concurrent judge sessions, ≤ 200 demo workspaces; 100×: webhook bursts ≤ 5/s) and latency targets (webhook ack < 500 ms, dashboard p95 < 800 ms). §12 says pg-boss at 20 concurrent jobs handles bursts with headroom. Those are assumptions until measured. Judges arriving together on Dec 1 is the realistic peak. Rubric: Technological Implementation (scaling story as numbers), Stage One (the demo stays up).

## Scope

- **Tooling:** a Node script `scripts/load/run.ts` (native `fetch`, fixed-rate scheduler, HDR-style percentiles; no new dependency). It writes a JSON result and a markdown summary
- **Launch load (production, Render Oregon):** 20 concurrent sessions for 10 min hit the dashboard, payment, pack, hold and dispute read routes at a think time of 2–5 s
  - the sessions come from 20 demo workspaces created by the seed CLI (`pnpm db:seed --loadtest 20`), tagged `loadtest`, created server-side so the public per-IP caps are untouched, and purged after the run
  - no AI or PayPal writes are triggered
  - measured: p50/p95/p99 per route, error rate, and Render CPU and memory for web and Postgres
- **Webhook burst, production:** 5/s for 5 min against `/api/webhooks/paypal`
  - (a) recorded real deliveries from `fixtures/paypal/webhooks/` replayed with their original headers. This exercises verify + dedupe; no re-fetch is enqueued
  - (b) forged signatures: expect a fast 400
  - measured: ack p95 (< 500 ms), and no 5xx
- **100× burst, local production-like stack** (fresh `make up`, production build, worker concurrency as in `render.yaml`): 1,500 unique events at 5/s, plus a 30 s spike at 20/s
  - signatures come from the M1-04 test signing harness, which is accepted only when `NODE_ENV=test`; a test asserts production refuses it at boot
  - the worker re-fetch replays recorded PayPal responses (msw), so no sandbox calls are made
  - measured: ack p95, queue depth over time, drain time, duplicates (must be 0), DLQ count (must be 0)
- **Cost check:** OpenAI spend during the run = $0 (asserted from `agent_runs`)
- **Report:** `docs/evidence/load-report.md` with the numbers, the environment, the date and the commit, compared with the §1 targets. Architecture §12's arithmetic is updated with the measured numbers
- Any target missed is fixed in this ticket (indexes, pool size, worker concurrency, caching with an invalidation rule) and re-measured

## Out of scope

- Frontend Core Web Vitals (M4-04)
- Security and abuse caps behaviour (M4-05)
- Plan upgrades on Render (needs the owner; propose with the numbers if required)

## Acceptance Criteria

- [ ] On production, launch load: dashboard and read routes p95 < 800 ms, error rate < 0.5%, from `pnpm load:launch` output
- [ ] On production, webhook replay burst: ack p95 < 500 ms, 0 5xx. Forged signatures return 400 with p95 < 200 ms
- [ ] Locally, the 100× burst: ack p95 < 500 ms; queue drains within 10 min of the burst end; duplicates 0; DLQ 0; every event has exactly one `webhook_events` row
- [ ] A test proves the test signing harness is rejected when `NODE_ENV=production`
- [ ] The `loadtest` workspaces are purged after the run (`pnpm db:count --tag loadtest` prints 0 on production)
- [ ] `docs/evidence/load-report.md` exists, and architecture §12 cites it

## Deliverables

- `scripts/load/{run,launch,webhook-burst}.ts`, the seed `--loadtest` option and its purge
- `docs/evidence/load-report.md`, the architecture §12 update
- Any performance fixes (migrations for indexes go through `packages/db/schema/*`, a hot file)

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
: "${PROD_URL:?set to the Render web URL (from .dev-refs.md)}"
# local 100x burst on a clean stack
make down && make up && pnpm db:migrate && pnpm db:seed
pnpm build
(NODE_ENV=test pnpm start:all & echo $! > "$TMPDIR/stack.pid")
for i in $(seq 1 60); do curl -sf localhost:3000/readyz >/dev/null && break; sleep 1; done
pnpm load:burst --target http://localhost:3000 --rate 5 --count 1500 --spike 20:30 --out "$TMPDIR/burst-local.json"
pnpm load:assert "$TMPDIR/burst-local.json" --ack-p95 500 --dup 0 --dlq 0 --drain 600
# production (DEPLOY claimed)
pnpm load:launch --target "$PROD_URL" --sessions 20 --minutes 10 --out "$TMPDIR/launch.json"
pnpm load:assert "$TMPDIR/launch.json" --p95 800 --err 0.005
pnpm load:burst --target "$PROD_URL" --replay fixtures/paypal/webhooks --rate 5 --minutes 5 --out "$TMPDIR/burst-prod.json"
pnpm load:assert "$TMPDIR/burst-prod.json" --ack-p95 500 --5xx 0
pnpm db:count --tag loadtest --target production
```

## Handoff

- **M4-GATE** checks the report exists and re-runs a 60 s local burst on a clean stack
- **M4-07** puts the measured headroom and the alert thresholds in the runbook
- **M5-01** quotes the measured numbers in "Measured results" and the scaling story
