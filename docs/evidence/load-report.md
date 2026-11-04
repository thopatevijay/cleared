# Load report (M4-06)

These are the measured numbers behind architecture §1's load and latency targets and the §12 scaling story. Every figure comes from a run listed here: its date, commit, environment and the exact command. Re-run with the commands in [How to re-run](#how-to-re-run).

## Summary against the §1 targets

| Target (architecture §1) | Measured | Where | Result |
|---|---|---|---|
| Dashboard and read routes p95 < 800 ms, launch load (20 concurrent sessions) | **pending**: the production run follows the merge (see [Production launch load](#production-launch-load)). Local reference: worst route p95 **38.9 ms**, 0 errors in 679 requests | production / local | pending |
| Webhook ack p95 < 500 ms, production | server-side p95 **1 ms** (p99 4 ms, n = 1,500). Client-side from Pune, India, p95 **344.1 ms**, network floor alone p95 320.9 ms. 0 × 5xx | Render, Oregon | PASS |
| Forged signature refused fast | **401**, server-side p95 1 ms (client-side p95 337.3 ms, n = 300) | Render, Oregon | PASS (status 401, not 400; see [Deviations](#deviations-from-the-ticket-text)) |
| 100× burst ack p95 < 500 ms | **15.7 ms** (n = 2,100 unique events plus 105 redeliveries) | local, production build | PASS |
| Queue drains ≤ 10 min after the burst | **35 s** (before the M4-06 worker fix it had not drained after 900 s) | local | PASS |
| Duplicates 0, DLQ 0, one `webhook_events` row per event | 0, 0, 2,100/2,100. The 105 redeliveries answered `duplicate` | local | PASS |
| OpenAI spend during the runs | **$0.0000** (`sum(agent_runs.cost_usd)` since the burst began) | local | PASS |

## 1. 100× webhook burst, local production-like stack

- **Date and commit:** 2026-11-03 12:33:23Z → 12:38:53Z, commit `369bcb0` (branch `feat/m4-06-load-test-03-11-2026`, after merging main `3bf0618`).
- **Stack:** set up by `make reset`, then the gate's `make down && make up && pnpm db:migrate && pnpm db:seed`, `pnpm build`, and `NODE_ENV=test pnpm start:all`.
  - One `next start` and one worker. Pools as in production: app pool 10, pg-boss 4 (the web's producer 2), worker concurrency 5 per queue (`apps/worker/src/boss.ts`).
  - Postgres 18.6 in Docker. Host: Apple M4, 10 cores, 24 GB.
- **Load:** 1,500 unique `PAYMENT.CAPTURE.COMPLETED` events at 5/s, then a 30 s spike at 20/s (600 more). That's 2,100 events, plus every 20th re-posted (105 redeliveries).
  - Each event is the recorded M0-06 delivery with a fresh event id, capture `LB…`, order `LO…` and `custom_id` = the seeded seller workspace.
  - Each is signed with the **test signing harness**: a run-scoped RSA key under `$TMPDIR`, trusted for one cert URL only under `NODE_ENV=test` (`apps/web/src/server/test-signing.ts`).
  - The orders are claimed for the workspace first, as Cleared's own order creation does.
- **Downstream:** the worker's capture re-fetch is answered by msw replaying the recorded M1-04 `GET /v2/payments/captures/:id` (`apps/worker/test/load/paypal-replay.ts`, preloaded only through `NODE_OPTIONS`). Every other PayPal, OpenAI or Resend request is refused, so the run made no vendor call.

| | n | p50 ms | p95 ms | p99 ms | max ms | statuses |
|---|---:|---:|---:|---:|---:|---|
| signed (unique events) | 2,100 | 7.0 | 15.7 | 22.7 | 104.2 | 200 × 2,100 |
| redelivery | 105 | 2.5 | 5.1 | 6.1 | 9.1 | 200 × 105 (`duplicate`) |
| healthz (network floor) | 20 | 1.0 | 1.5 | 3.1 | 3.1 | 200 × 20 |

Queue: peak **540** jobs pending; **drained 35 s** after the last request; 2,100 of 2,100 events with exactly one `webhook_events` row; duplicates 0 (`webhook_events` per event id and `payments` per capture id); DLQ 0; failed jobs 0; OpenAI $0.

### The fix this run measures: consumers burst while their queue has a backlog

The same burst on the code before the fix (commit `1871f2d`, 2026-11-03 11:57:50Z):
- Ack p95 was 20.4 ms, so the web was never the problem.
- The queue peaked at **2,061** pending and drained at a steady **2.5 jobs/s**. It had **not drained 900 s** after the burst.
- `paypal.capture.sync` jobs ran in 29 ms each but waited 26 s on average for a slot.

The cause is in pg-boss 12: after every fetch, each of the 5 consumer slots sleeps the 2 s poll interval unless burst mode is on, so a queue drains at ≤ 5 / 2 s = 2.5 jobs/s, below a 5/s burst. `burstWhenReadyExceeds: 1` (`apps/worker/src/boss.ts`) lets a slot fetch again at once while its queue has a backlog, and an empty fetch drops it back to polling. Idle cost is unchanged. After the fix: peak 540, drained in 35 s.

The baseline run also showed the reconcile poll (M3-09) enqueueing ~1,850 capture re-fetches in one tick, 13 min after the burst: every owned capture changed in the last 72 h, up to 2,000 per tick. That's harmless at launch scale. The 100× note is in §12 and in BL-01 6603617791.

## 2. Production webhook burst

- **Date and commit:** 2026-11-03.
  - Gate run: 12:46:42Z → 12:51:42Z, from commit `cfe3170`. Three earlier runs, at 11:59:56Z, 12:26:11Z and 12:39:30Z, gave the same results.
  - Production web on release `5169496` (main), Render `starter`, Oregon.
  - Client: a home connection in Pune, India.
- **Load:** 5 requests/s for 5 min (1,500).
  - Four in five are the 13 recorded deliveries under `fixtures/paypal/webhooks/` (deliveries and simulator) with their **original headers**.
  - Every fifth is **forged**: a recorded delivery with a fresh transmission time (so it passes the skew check and reaches the signature check) and a signature that isn't PayPal's.
- **What it exercises:** the verify path only. The recorded deliveries are scrubbed and dated 2026-10-29, so the verifier refuses them as `stale_transmission_time`. The forged ones fail as `bad_signature` against PayPal's real sandbox cert, fetched once and then cached. Nothing is stored and no job is enqueued. Dedupe under load is measured locally (§1).
- **Server-side timings:** from Render's request log (`durationMs` per request, `scripts/load/render-logs.ts`). The client-side figures include the India → Oregon round trip.

| | n | client p50 | client p95 | client p99 | statuses |
|---|---:|---:|---:|---:|---|
| replay (original headers) | 1,200 | 268.3 | 344.1 | 482.6 | 401 × 1,200 |
| forged | 300 | 268.3 | 337.3 | 395.5 | 401 × 300 |
| healthz (network floor) | 20 | 250.2 | 320.9 | 416.5 | 200 × 20 |

| Server-side (Render log) | n | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|
| `/api/webhooks/paypal` | 1,500 | 0 | 1 | 4 | 70 |

Run 1 (11:59:56Z): server-side p95 9 ms, p99 14 ms, max 68 ms (the first cert fetch, 230 ms, is in that window). 0 × 5xx in every run.

## Production launch load

**Pending.** It needs the seed CLI (`seed.ts --loadtest`) on the Render worker, which ships with this ticket's merge. Deploying a branch commit to production isn't allowed. After the auto-deploy from main (check `render deploys list` shows the merge commit live on web and worker), run:

```bash
pnpm load:launch --target "$PROD_URL" --sessions 20 --minutes 10 --out "$TMPDIR/launch.json"
pnpm load:assert "$TMPDIR/launch.json" --p95 800 --err 0.005
pnpm db:count --tag loadtest --target production
```

What it does:
- 20 sessions, each in its own `loadtest` workspace, made server-side by `render ssh <worker> -- node packages/db/src/seed.ts --loadtest 20`.
- Each workspace is `demo` + `synthetic`, outside the demo caps. It holds a completed payment, a review hold, and a disputed payment with its dispute, packs and evidence, claimed like the syncs claim them. The reconcile poll skips these workspaces, so there are no PayPal calls.
- Each session browses 13 steps for 10 min with a 2–5 s think time: the dashboard (`/en/payments` and `/api/payments`), the pack page and API, the holds list and detail, the disputes list and detail, and notifications. Nothing writes, runs AI or calls PayPal.
- At the end it purges the workspaces, also on failure.

**Local reference** (same scenario, 2026-11-03 12:52Z, 20 sessions for 2 min, local production build):
- 679 requests, 0 errors.
- Overall p95 26.4 ms. The worst route p95 is 38.9 ms (the dashboard page and the pack page).

**Render CPU and memory** for web and Postgres during the run: the Render CLI has no metrics command and the agent holds no API key (BL-01 6603618375). The owner reads the dashboard Metrics tab for the run window and adds the peaks here.

## M4-08 follow-up: the data routes (2026-11-03)

The production launch run on `379d4e4` (#50) had 0 errors, but its overall p95 was 949 ms against 800. Seven routes were over: `GET /api/payments` 1,413 ms, `/api/disputes/[id]` 1,170, `/api/packs/[id]` 968, `/api/holds` 940, the page `/en/holds/[id]` 886, the page `/en/payments/[id]/pack` 826 and `/api/holds/[id]` 818. The network floor from Pune was p95 337 ms. M4-08 (#142) worked on the server side of those routes.

**What the database does on these routes.** Postgres statement logging covered the journey's traffic. The slowest application statement took 0.36 ms, and no read statement took more than that. The tables hold a few hundred rows; production keeps demo workspaces for a limited time (ADR 0020), so they stay small there too. No index would change these numbers, so **M4-08 adds no index and no migration**.

**What changed:**
- **Fewer database round trips per request.** Reads that don't depend on each other now run together:
  - `/api/disputes/[id]`: the payment and the drafts; the pack items join the main stage.
  - `/api/holds/[id]`: the hold, the time zone and the explanations.
  - `/api/payments`: the workspace row joins the first stage.
- **First views are rendered on the server.** The pages `/en/payments`, `/en/payments/[id]/pack`, `/en/holds/[id]` and `/en/disputes/[id]` call their API's own handler and render its data into the HTML (`apps/web/src/server/first-view.ts`). A page request now does the work of its API request, so these pages take longer on the server. The browser still refreshes the data with one API call after it loads, as before.

**Local server-side p95** (`pnpm load:server-timing`: 20 sessions on the launch journey with 2–5 s think time, 2 min, local production build on loopback, Apple M4; each route n ≈ 50):

| Route | Before (`01b5b3e`) | After (this PR) |
|---|---:|---:|
| `GET /api/payments` | 20.8 ms | 19.2 ms |
| `GET /api/disputes/[id]` | 20.4 | 17.2 |
| `GET /api/packs/[id]` | 23.9 | 21.2 |
| `GET /api/holds` | 19.0 | 19.0 |
| `GET /api/holds/[id]` | 17.7 | 10.8 |
| page `/en/holds/[id]` | 25.6 | 35.6 |
| page `/en/payments/[id]/pack` | 30.7 | 33.5 |
| page `/en/payments` (not one of the seven) | 21.4 | 43.0 |
| page `/en/disputes/[id]` (not one of the seven) | 21.0 | 40.9 |

Every one of the seven is far under the 400 ms server-side budget on this machine. The same routes took 800–1,400 ms on Render, so locally the database and the code are not the bottleneck. **Cold start:** with no warm-up pass, the first concurrent requests after `next start` stalled for 1.1–2.3 s (`GET /api/payments` p95 1,280 ms in a 2-minute run). The harness warms up by default and measures steady state; `--no-warmup` measures the cold start. A deploy or restart during a judge's session will show that stall once.

**What this doesn't prove.** The local machine is much faster than a Render `starter` instance (0.5 CPU). Whether the remaining production time is CPU on that plan can only be shown on production. **The production re-measure (DEPLOY holder, after merge and deploy) must show:**
- `pnpm load:launch --target "$PROD_URL" --sessions 20 --minutes 10` → `load:assert --p95 800 --err 0.005` passes.
- Render's server-side `durationMs` p95 for each of the seven routes is at or under 400 ms.

If the server-side p95 is still above 400 ms while the database stays sub-millisecond, the limit is the plan's CPU. Read the Render Metrics tab for the run window (CPU near 100 % on `web`) and write that up for the owner's plan decision. Don't change the threshold.

## Deviations from the ticket text

- **Forged signature → 401, not 400.** 401 is the M1-04 contract (`apps/web/test/webhooks/paypal-webhook.int.test.ts`, "tampering → 401"). A 400 comes back only for a verified body that isn't an event envelope. `load:assert` checks that every forged delivery gets a 4xx and reports the real status (BL-01 6603616566).
- **The 200 ms refusal target is checked server-side.** From India the round trip alone is above 200 ms (network floor p95 320.9 ms). When the run captured Render's log, `load:assert` checks the server-side p95, and it prints the client figure next to it.
- **The production replay can't reach dedupe.** See §2. It's measured locally.

## Cost

OpenAI spend during the local burst was $0.0000 (`agent_runs`), and the production runs trigger no AI. PayPal calls: none from Cleared. Production made one public cert GET for self-verify.

## How to re-run

- **Local (M4-GATE re-runs a 60 s burst):** `export PORT_OFFSET=<n> DATABASE_URL=…`, then `make reset`, `source scripts/load/local-env.sh`, then the gate lines. The env file prepares a run-scoped session secret, a dummy PayPal client, the harness key pair under `$TMPDIR` and the msw preload. It never touches `.env`. A 60 s burst: `pnpm load:burst --target http://localhost:3000 --rate 5 --count 300 --out …`.
- **Local data-route timing (M4-08):** after `pnpm --filter @cleared/web build` and a migrated, seeded database: `pnpm load:server-timing --routes payments,disputes-id,packs-id,holds,holds-id,page-holds-id,page-pack --p95 400`. It starts `next start` itself, seeds its own loadtest workspaces and purges them afterwards.
- **Production:** the DEPLOY holder runs the burst and launch lines. The burst trips the Sentry alert "webhook verification failures above 5 per 10 min" by design (BL-01 6603619029). Don't run it during the judging window without telling the owner.
