# Runbook: judging, 2026-12-01 to 2026-12-15

Judging runs from **2026-12-01 14:00 PT** to **2026-12-15 08:00 PT**. The hosted demo must work the whole time: a demo that doesn't work disqualifies the project (PROJECT.md §1). This page gives the owner a daily routine of about 10 minutes and a playbook per failure. Tracing a single error (correlation id → job → PayPal `debug_id`) is in [`docs/runbook/observability.md`](../runbook/observability.md). The review-hold pool refills are in [`docs/runbooks/review-hold-pool.md`](../runbooks/review-hold-pool.md).

**Where things are**

| What | Where |
|---|---|
| Web | `cleared-web`, `srv-dbheesg473hc739p3g0g`, <https://cleared-web-gd1b.onrender.com> |
| Worker | `cleared-worker`, `srv-dbhehn0473hc739paf3g` |
| Database | `cleared-db`, `dpg-dbheefg473hc739p28u0-a` (Postgres 18, basic-256mb, 1 GB storage) |
| Read-only SQL | `~/.local/bin/cleared-prod-select "<select …>"`, from the home IP only (it is refused on a hotspot) |
| Sentry | org `hackathons-si`, project `cleared` |
| Caps | `LLM_DAILY_CAP_USD` (default 1), `DEMO_WORKSPACES_GLOBAL_MAX` (default 200), `AGENT_KILL_SWITCH`: env group `cleared-shared` in `render.yaml` |

## Daily checks

Do these once a day, in this order. Each one names its command or link and what counts as **OK**. Put the date and any non-OK line in the M5-SUBMIT issue as a comment.

### 1. Synthetic judge path

The worker runs the whole judge path in its own synthetic workspace every day at 03:00 UTC (M3-09).

```sql
-- cleared-prod-select
select run_at, pass, value as seconds, detail->>'failedStep' as failed_step
from ops_checks where "check" = 'synthetic' order by run_at desc limit 3;
```

**OK:** the latest row is under 26 h old and `pass = true`. Otherwise, follow the playbook its `failed_step` points to: PayPal or OpenAI. To re-run it now: `render ssh srv-dbhehn0473hc739paf3g --confirm -o text -- 'node apps/worker/src/cli/synthetic.ts'`. Locally the same run is `pnpm --filter ./apps/worker run synthetic`.

### 2. `/healthz` and `/readyz`

```bash
curl -s https://cleared-web-gd1b.onrender.com/healthz
curl -s https://cleared-web-gd1b.onrender.com/readyz
```

**OK:** `/healthz` answers `{"ok":true,"commit":"<sha>"}`, and the sha is the last commit on `main` that should be live. `/readyz` answers `200` with `db`, `queue`, `worker` and `reconcile` all `true`. A `503` table is in observability.md, *Health endpoints*.

### 3. Sentry new issues

Sentry → project `cleared` → Issues, filtered `is:unresolved firstSeen:-24h`. The Sentry MCP's read tools work too.

**OK:** no new issue. Expected noise: `webhook quarantined` with `anotherEnvironment`, and the CSP violation for Bryntum's GTM (threat model L-7). Any other new issue goes to *A judge-reported bug*.

### 4. Render service health and deploys

```bash
render services list -o text
render deploys list srv-dbheesg473hc739p3g0g -o text
render deploys list srv-dbhehn0473hc739paf3g -o text
```

**OK:** both services are `live`, the newest deploy of each is `live` with the expected commit, and no deploy failed. During the change freeze, every deploy must match a fix PR.

### 5. OpenAI spend today vs `LLM_DAILY_CAP_USD`

```sql
-- cleared-prod-select
select round(coalesce(sum(cost_usd), 0)::numeric, 4) as usd_today
from agent_runs where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
```

**OK:** under 80 % of `LLM_DAILY_CAP_USD`. The total stays within the $80 ceiling in `docs/budget.md`. At the cap, follow *OpenAI outage or cap reached*.

### 6. Demo workspaces vs `DEMO_WORKSPACES_GLOBAL_MAX`

```sql
-- cleared-prod-select
select count(*) filter (where expires_at > now()) as live,
       count(*) filter (where created_at > now() - interval '1 day') as last_24h
from workspaces where kind = 'demo' and not synthetic;
```

**OK:** `live` is under 80 % of `DEMO_WORKSPACES_GLOBAL_MAX`. Each IP gets 3 demo workspaces a day. At the global cap, follow *Global demo workspace cap reached*.

### 7. Webhook lag

```sql
-- cleared-prod-select
select max(received_at) as last_webhook, now() - max(received_at) as lag,
       count(*) filter (where status = 'received' and received_at < now() - interval '10 minutes') as unprocessed
from webhook_events where provider = 'paypal';
```

**OK:** the last webhook is no older than the newest sandbox activity (the synthetic run makes some every day, so under 26 h), and `unprocessed` is 0. A lag with sandbox activity after it: follow *Webhook registration lost*.

### 8. Dead-letter queues

```sql
-- cleared-prod-select
select name, count(*) from pgboss.job where name like '%.dlq' and created_on > now() - interval '1 day'
group by name order by 2 desc;
```

**OK:** no rows. Each row also raised a Sentry `message dead-lettered: <queue>` error. Follow its correlation id (observability.md).

### 9. Nightly eval green

```bash
gh run list -R thopatevijay/cleared --workflow eval.yml --limit 3
```

**OK:** the newest scheduled run is under 26 h old and `completed success`. The nightly eval (M4-02) uses live OpenAI with the recorded gold sets. A red run means a model or prompt regressed: no prompt, model or schema change merges until it is green again (CLAUDE.md).

### 10. PayPal sandbox status

<https://www.paypal-status.com/> → *Sandbox*.

**OK:** all sandbox APIs are operational. Also compare check 1: a failing synthetic step at `capture`, `chargeback` or `decide` while PayPal is green means PayPal changed behaviour. Follow *PayPal sandbox down or changed behaviour*.

## Playbooks

Each playbook gives the symptom, the check, the action and the rollback. An action marked **owner** is never taken by an agent (CLAUDE.md, *Still the owner's*).

### OpenAI outage or cap reached

- **Symptom:** explanations, extractions or drafts show the degraded state ("AI is unavailable: facts shown without a verdict", or the budget banner). Sentry has OpenAI `outbound call failed` lines, or the scenario refuses with the daily-cap message.
- **Check:** <https://status.openai.com/>. Daily check 5 for the spend. Worker logs for `vendor: openai` with `status` 429/5xx or `failure: timeout`.
- **Action:** nothing to switch: the degraded mode is already built (M2), and evidence, facts and PayPal actions keep working. For an outage, wait, and note it in the daily log. Raising the cap is an **owner** decision, every time: edit `LLM_DAILY_CAP_USD` in the Render env group, within the $80 ceiling in `docs/budget.md`.
- **Rollback:** set `LLM_DAILY_CAP_USD` back to its previous value. The cap counts again from the next 00:00 UTC.

### PayPal sandbox down or changed behaviour

- **Symptom:** the synthetic run fails at `capture`, `chargeback`, `decide` or `resolved`. "Create a sandbox test payment" errors. Outbound PayPal calls return 5xx or a new 4xx.
- **Check:** daily check 10. Worker `outbound call` lines with `vendor: paypal`, their `status` and `paypalDebugId`. A 4xx with a new `name`/`issue` means a behaviour change. Compare it with the recorded response in `fixtures/paypal/`.
- **Action:** if PayPal is down, wait. Mirrors catch up through the 15-minute reconcile poll and the webhook retries, with no action needed. If behaviour changed, record the new response, log it to BL-01, and fix it on a branch (a fix PR under the change freeze). Quote the `paypalDebugId` to PayPal merchant technical support. PayPal sandbox resources can't be deleted or replayed, so never try to "reset" a capture or dispute.
- **Rollback:** revert the fix PR. The Render rollback is in *A bad deploy*.

### Webhook registration lost

- **Symptom:** daily check 7 shows no webhook after sandbox activity. Payments made in the demo stay on "Waiting for PayPal…" until the reconcile poll picks them up, up to 15 min later. Or Sentry shows `webhook verification failures above 5 per 10 min`.
- **Check:** `pnpm tsx scripts/setup.ts --list-webhooks` (local, with the sandbox credentials loaded through the WORKFLOW.md launcher; never copy `.env`) lists the app's webhooks. The Render URL must be there with every event type.
- **Action:** re-run the idempotent setup script: `pnpm tsx scripts/setup.ts --url https://cleared-web-gd1b.onrender.com`. If it prints a **new** webhook id, the **owner** puts it in Render → `cleared-web` → Environment → `PAYPAL_WEBHOOK_ID`, and the web service redeploys. The reconcile poll has already covered the gap. No replay is needed: a re-fetch on every webhook means order doesn't matter.
- **Rollback:** none needed: the script is idempotent. A webhook it created for a wrong URL is removed with `pnpm tsx scripts/setup.ts --delete-url <base>` (that command refuses the Render URL).

### Global demo workspace cap reached

- **Symptom:** "The demo is busy right now. Try again in … minutes." on the landing page (cap `demo_global`). Daily check 6 shows `live` at `DEMO_WORKSPACES_GLOBAL_MAX`.
- **Check:** find abandoned and load-test workspaces: no payments and no scenario run, older than 24 h.

  ```sql
  -- cleared-prod-select
  select w.id, w.created_at from workspaces w
  where w.kind = 'demo' and not w.synthetic and w.expires_at > now() and w.created_at < now() - interval '1 day'
    and not exists (select 1 from payments p where p.workspace_id = w.id)
    and not exists (select 1 from scenario_runs s where s.workspace_id = w.id)
  order by w.created_at;
  ```

- **Action:** expire those workspaces, so they stop counting towards the cap. The **owner** runs this with Render → `cleared-db` → Connect → PSQL; the read-only helper can't write: `update workspaces set expires_at = now() where id in (…ids from the check…) and kind = 'demo'`. Their data is purged 6 days later by the daily retention purge. Raising `DEMO_WORKSPACES_GLOBAL_MAX` is an **owner** decision (env group `cleared-shared`); Postgres storage is the limit to watch (see *Postgres near its storage limit*).
- **Rollback:** before the purge runs (6 days later), `update workspaces set expires_at = '2026-12-16T00:00:00Z' where id in (…)` restores them. After the purge, their rows are gone. They held synthetic data only.

### A bad deploy

- **Symptom:** after a deploy, `/healthz` shows the new commit while `/readyz` is 503, the synthetic run fails, Sentry spikes, or a judge path breaks.
- **Check:** daily check 4 (deploy list), Sentry filtered by `release:<sha>`, and the web pre-deploy (`migrate`) log.
- **Action:** roll back on Render: service → Events/Deploys → the previous live deploy → **Rollback** (<https://render.com/docs/rollbacks>). Roll back web and worker together when the deploy changed both. Then revert the PR on `main`. A deploy whose migration ran can't be undone by a rollback. Migrations are additive (new columns, tables and functions), so the previous code runs against the new schema. Check this before rolling back a migration PR.
- **Rollback:** redeploy the reverted commit's successor once fixed. After a Render rollback, check that auto-deploy is still on for both services, and switch it back on if Render turned it off.

### Postgres near its storage limit

- **Symptom:** Render warns about `cleared-db` disk usage, or writes fail with `could not extend file`.
- **Check:** Render → `cleared-db` → Metrics (disk). Then the biggest tables:

  ```sql
  -- cleared-prod-select
  select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
  where relkind = 'r' order by pg_total_relation_size(oid) desc limit 8;
  ```

- **Action:** in order:
  1. If `pgboss.job` is on top, check that the worker is up (`/readyz`): pg-boss's own maintenance, which runs in the worker, removes old completed jobs.
  2. `blobs` from abandoned demo workspaces: expire them as in *Global demo workspace cap reached*. Their purge then frees the space after 6 days.
  3. Adding storage is a purchase, an **owner** decision ($0.30 per GB, `docs/budget.md`).
- **Rollback:** none: the purge removes only synthetic data, and storage can grow but never shrink on Render.

### Bryntum trial expires or stops rendering

- **Symptom:** the cash calendar (`/en/calendar`) shows the trial-expired notice, or a blank area where the calendar was.
- **Check:** the browser console on `/en/calendar`, and the date of the trial extension Bryntum confirmed (P-38, recorded on M0-01 #3 and #58).
- **Action:** the accessible upcoming-releases list on the same page (`cash-calendar/list.tsx`) keeps the information usable meanwhile. It renders without Bryntum. Contact Bryntum (Discord DM, and the M0-01 email thread with sales@bryntum.com) and ask for the extension until 2026-12-15. A renewed trial key from Bryntum v8 needs a follow-up ticket (#58). Never re-bundle Bryntum: it loads at runtime from `/vendor` (#129).
- **Rollback:** none: the list view stays.

### A judge-reported bug

- **Symptom:** a judge reports a problem: on Devpost, by email, or as a GitHub issue.
- **Check:**
  1. Reproduce it on the hosted demo in a fresh "Try as demo seller" workspace.
  2. Get the correlation id from the error panel and follow it in the logs (observability.md).
  3. Check Sentry for the same route.
- **Action:**
  1. Reply within 24 h. Say what you saw and when the fix lands. Only claim what a test proves.
  2. Log the bug to BL-01.
  3. Fix it on a branch, with a test that reproduces it (a fix PR under the change freeze), and run the synthetic check after the deploy.
  4. If the bug can move money or file something wrongly, switch on the kill switch first.
- **Rollback:** *A bad deploy*.

### The kill switch (`AGENT_KILL_SWITCH`)

- **Symptom:** the agent proposes or executes something wrong, a PayPal write misbehaves, or AI spend runs away.
- **Check:** the newest `audit_log` rows and `proposed_actions` with their `state` (`cleared-prod-select "select at, action, workspace_id from audit_log order by at desc limit 20"`).
- **Action:** stop every execution of seller-approved actions and every AI run (ADR 0010). Either set `AGENT_KILL_SWITCH=true` in the env group `cleared-shared` (both services redeploy, so it takes a few minutes), or set the database flag, which takes effect at once with no deploy:

  ```sql
  -- owner, Render PSQL
  insert into platform_flags (id, agent_kill_switch, updated_at) values (1, true, now())
  on conflict (id) do update set agent_kill_switch = true, updated_at = now();
  ```

  Drafts stay saved, and the UI says "Sending to PayPal is paused. Your draft is saved." The sandbox scenario simulator (test payment, buyer chargeback, PayPal's decision) is not stopped: accepted design A-7, still pending the owner's confirmation.
- **Rollback:** set the env var back to `false`, or set `agent_kill_switch = false` with the same statement. Stranded `unknown` actions are reconciled by the 15-minute poll.

## Known limitations

- **Alert emails land in spam.** Dispute and hold alert emails go out from Resend's shared `resend.dev` sender, with no verified domain (owner decision P-44), and only to `EMAIL_RECIPIENT_ALLOWLIST`. Resend reports them delivered, but in the M4-GATE production run (2026-11-04) both landed in the spam folder. Check the spam folder before treating an alert as missing; the in-app bell shows the same alert and is the reliable signal. Don't change the sender during judging (it needs a domain, an owner decision). BL-01 6629802819.

## Change freeze

From **2026-12-01**, `main` takes fixes only. Each fix is a PR with a test that reproduces the bug, CI green, and squash-merged. After each deploy:

1. Run the synthetic check (daily check 1, *re-run it now*) and wait for `pass = true`.
2. Run daily checks 2 and 4.

`render.yaml` is frozen. A merge that changes it deploys through **Blueprint sync** before CI on `main` has finished (BL-01 6531555980). The "deploy only after checks pass" trigger doesn't cover Blueprint changes, and no Render setting to make a Blueprint wait for checks was found. If a `render.yaml` change can't wait, merge it only from a PR whose own CI is green, watch `main` CI after the merge, and roll back if it goes red. No dependency upgrades, prompt or model changes, or migrations during the freeze unless they are the fix.

## Thresholds

| Signal | Threshold | Source |
|---|---|---|
| Synthetic judge path | ≤ 1 800 s end to end, a passing run every 26 h | ADR 0013, `ops_checks` (M3-09) |
| Webhook → hold visible | p99 < 120 s | `slo.hold_visible_p99` |
| Approval → PayPal send | p99 < 300 s | `slo.approved_to_paypal_p99` |
| Missed dispute deadlines | 0 | `slo.missed_deadlines` |
| OpenAI spend | < `LLM_DAILY_CAP_USD` per UTC day; total within $80 | `docs/budget.md`, M4-05 worst-case reservation |
| Live demo workspaces | < `DEMO_WORKSPACES_GLOBAL_MAX` (200); 3 per IP per day | ADR 0007 |
| Postgres storage | < 1 GB | `docs/budget.md` |
| Load (M4-06) | **Measured 2026-11-03:**<br>• Webhook ack p95 < 500 ms. Production server-side p95 is 1 ms at 5/s (n = 1,500, 0 × 5xx), and the local 100× burst p95 is 15.7 ms.<br>• Queue drains within 10 min of a burst: 35 s after 2,100 events.<br>• DLQ 0 and duplicates 0.<br>• Read routes p95 < 800 ms and errors < 0.5% at 20 concurrent sessions. **Production (2026-11-03, from India, network floor p95 337 ms): overall p95 949.4 ms, error rate 0.000%. The p95 target is missed on 7 of 13 routes (FAIL).** The local reference p95 is 38.9 ms with 0 errors.<br>• A `load:burst` against production trips the "verification failures" Sentry alert by design, so don't run it Dec 1–15 without the owner. | [`docs/evidence/load-report.md`](../evidence/load-report.md) |

**Residual risks to keep in mind** (M4-05, `docs/security/threat-model.md`):

- **L-1, L-2:** the AI reservation can overshoot a cap by one call's input under-estimate, and it fails closed.
- **L-3:** link rate limits can overshoot by a few.
- **L-4:** confirmed (#168): Render sets `True-Client-IP` (10/10 production `demo client ip source` log lines, 2026-11-05), so the cap is 3 demo workspaces per network per rolling 24 h. Judges behind one office or event NAT share that bucket; the 429 panel shows when the next slot frees and links to the README's "How to judge in 5 minutes". If judges report the cap early, check `demo client ip source` in the web logs.
- **L-5:** about 0.7 MB of extra client JavaScript.
- **L-6:** build-time advisories.
- **L-7:** Bryntum's GTM is refused by the CSP.
- **Accepted designs A-1 to A-7:** in the threat model. A-7, the kill switch vs the simulator, still needs the owner's confirmation.

## Retention and purge

- **Policy** (ADR 0020, `packages/core/src/retention.ts`):
  - Demo workspaces created before 2026-12-16 expire on **2026-12-16** and are purged on **2026-12-22**.
  - One created later lives 7 days and is purged 6 days after it expires.
  - Seller workspaces are never purged automatically.
- **Job:** `retention.purge`, daily at 04:00 UTC in the worker. Each workspace is one transaction through `purge_workspace(uuid)`, which writes one counts-only `retention.purged` audit row (`workspace_id` null). It is safe to re-run: a purged workspace is never picked again.
- **Dry run:** locally, `FAKE_NOW=2026-12-22T00:01:00Z pnpm --filter @cleared/worker exec tsx src/jobs/retention-purge.ts --dry-run`. On production, the purge runs on its own; a check without the fake clock is `render ssh srv-dbhehn0473hc739paf3g --confirm -o text -- 'node apps/worker/src/jobs/retention-purge.ts --dry-run'`. `FAKE_NOW` is for tests and rehearsals; it is never set in production.
- **After 2026-12-22:** read the audit rows to confirm the purge.

  ```sql
  -- cleared-prod-select
  select count(*) from audit_log where action = 'retention.purged';
  select count(*) from workspaces where kind = 'demo' and purged_at is null and expires_at < now() - interval '6 days';
  ```

  The second count must be 0, or 1 for the review-hold pool workspace (kind `seller`, never purged).
- **Scope:** PayPal sandbox resources (orders, captures, disputes, uploaded evidence) can't be deleted through PayPal's API. The purge removes Cleared's copies only. The sandbox accounts are synthetic.
- **The project stays available until 2026-12-15** (hackathon rule). Only the demo data is purged; the hosted app stays up.

## Local maintenance

These are notes for the agent workflow, not for production (BL-01 6570430739):

- A worktree removed without `make down` can leave its compose Postgres running and holding its port. `docker ps` shows it as `agent-…-postgres-1`. Remove it with `docker rm -f <name>`.
- A long-lived local database collects unpublished outbox rows from integration tests, and the e2e worker re-sends them at start. Run `make reset` before local e2e.

## Checking this page

`pnpm runbook:check` checks this page:

- every daily check and playbook in the M4-07 scope has its heading;
- each playbook has its Symptom, Check, Action and Rollback lines;
- every pnpm command on the page exists in the right `package.json`: a script, or a binary from a dependency.
