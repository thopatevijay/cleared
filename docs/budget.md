# Budget

Ticket M0-00 · prices checked 2026-10-28 · **owner-approved ceiling: $80 total through 2026-12-22** (decision P-43 on issue #2).

## Period

| Window | Dates | Days | Why |
|---|---|---|---|
| Development | 2026-10-30 (first Render deploy, M0-08) → 2026-11-12 | 14 | build to the submission deadline |
| Judging | 2026-11-13 → 2026-12-15 | 33 | the demo must stay testable until 2026-12-15 (rules) |
| Purge tail | 2026-12-16 → 2026-12-22 | 7 | the worker runs the retention purge on 2026-12-22 (M4-07), then the services are deleted |

## Cost table

| Service | Plan | Unit price | Development | Judging | Purge tail | Buy? |
|---|---|---|---|---|---|---|
| Render web | Starter (0.5 CPU, 512 MB), Oregon | $7/mo | $3.27 | $7.70 | $1.63 | **yes**: the free tier spins down |
| Render worker | Starter, Oregon | $7/mo | $3.27 | $7.70 | $1.63 | **yes**: no free tier for workers |
| Render Postgres | basic-256mb (1 GB storage included), Oregon | $6/mo | $2.80 | $6.60 | $1.40 | **yes**: free Postgres expires after 30 days |
| Render bandwidth | Hobby workspace: 5 GB/mo included, then $0.15/GB | $0 | $0 | $0 | $0 | no purchase (expected well under 5 GB) |
| OpenAI | pay-as-you-go, owner key | see below | ≈ $9 expected | ≈ $8 expected | $0 | **yes**: owner key; project budget enforces the cap |
| Resend | Free: 3,000/mo, 100/day | $0 | $0 | $0 | $0 | no purchase (owner-only email, no domain: P-44) |
| Sentry | Developer (free): 5k errors, 1 user, 30-day lookback | $0 | $0 | $0 | $0 | no purchase |
| Bryntum Calendar | trial | $0 | $0 | $0 | $0 | no purchase (permission pending, M0-01; FullCalendar MIT fallback) |
| GitHub | Free, private repo: 2,000 Actions minutes/mo | $0 | $0 | $0 | $0 | no purchase (see the CI minutes risk below) |
| Devpost, YouTube, Discord, cloudflared | free | $0 | $0 | $0 | $0 | no purchase |
| **Total expected** | | | **≈ $18** | **≈ $30** | **≈ $5** | **≈ $53** |

Render prices are per month and billed pro rata per second, so a service costs its monthly price × days / 30.

## OpenAI spend

| Use | Window | Expected | Hard bound |
|---|---|---|---|
| M0-07 spike | development | $0.50 | the ticket stops at $0.50 |
| Live tests in M2/M3 (recorded once, then replayed) | development | ≈ $3 | `LLM_DAILY_CAP_USD` = $1/day (app runs) |
| Gold-set drafting and second-model review (M4-01) | development | ≈ $2 | per-run recording in `packages/evals/gold/SPEND.md` |
| Live eval runs (M4-02, PR-triggered) | development | ≈ $3 | `EVAL_MAX_USD` = $1 per run |
| Judge demo workspaces | judging | ≈ $3 | $0.10 per workspace × 200 workspaces global cap, inside $1/day |
| Daily synthetic judge path (M3-09) | judging | ≈ $0 | canned evidence, served by the content-hash cache |
| Nightly live eval (M4-02 cron) | judging | ≈ $5 | `EVAL_MAX_USD` per run, **outside** `LLM_DAILY_CAP_USD` (GitHub secret key) |
| **Total** | | **≈ $17** | **≤ $44** (project budgets below) |

## The ceiling and what enforces it

| Bound | Value | Where | Who |
|---|---|---|---|
| Total ceiling | **$80** through 2026-12-22 | this file | owner (approved 2026-10-28) |
| Render | 3 starter services ≈ $20/mo → **≈ $36** for the 53 days | Render billing | fixed by plan; no autoscaling, no extra instances |
| OpenAI project budget, October and November | **$25/mo** with an alert at 80% | platform.openai.com → Settings → Projects → cleared → Limits (P-25) | owner |
| OpenAI project budget, December | **$14** (set on 2026-12-01; judging runbook) | same | owner |
| Global app cap | `LLM_DAILY_CAP_USD=1` (UTC day) | `.env` / Render env; enforced in the agent harness before every call (M2-02) | code |
| Per demo workspace | `LLM_WORKSPACE_CAP_USD=0.10` | same | code |
| Per eval run | `EVAL_MAX_USD=1` | GitHub variable / env; the eval runner stops when reached (M4-02) | code |

Worst case: Render $36 + OpenAI $5 (Oct 28–31 at $1/day plus the spike) + $25 (Nov) + $14 (Dec) = **$80**.

**Render credit (owner-reported 2026-10-29):** a $50 "Hackathon Participant" Render credit is active on the Hobby workspace, valid to 2027-10-01. Render applies credits to "any costs accrued by your workspace… plan fee, compute usage, bandwidth" at the end of each monthly period, and any overage goes to the card on file (render.com/docs/credits). The Hobby plan has no monthly fee (render.com/docs/platform-features-by-plan). The ≈ $36 Render total therefore comes out of the credit, so expected **out-of-pocket ≈ $17 (OpenAI only)**, with the $80 ceiling unchanged. Never upgrade to a paid workspace plan: its fee would draw on the same credit. Check Billing → Usage weekly until 2026-12-15.

## Assumptions

- The Render services are created on 2026-10-30 (M0-08) and deleted after the purge on 2026-12-22. Deleting them earlier saves about $0.67/day.
- Postgres stays under the 1 GB included storage (evidence blobs are small synthetic files; the load test purges its workspaces). Each extra GB is $0.30.
- Prices are in USD before card FX or local taxes (for example GST on a foreign service), which the owner's bank adds.
- AI costs per pack are estimates until M0-07 measures them; M0-07 updates this file if the measured cost per pack moves the totals by more than $5.
- Free tiers as stated on the vendors' pricing pages on 2026-10-28: render.com/pricing, resend.com/pricing, sentry.io/pricing.

## Risks

- **GitHub Actions minutes:** a private repo on GitHub Free gets 2,000 minutes a month. About 60 tickets × several CI runs × ≤ 5 min, plus the nightly eval, can come close in November. Spending is $0 by default, so CI would stop rather than bill. Mitigations: `concurrency: cancel-in-progress` on PR CI, path filters, and checking usage at github.com/settings/billing during M2. The limit disappears once the repo goes public (M5-SUBMIT).
- **Nightly eval spend sits outside the app cap** (logged on BL-01 for M4-02): it uses the GitHub-secret key and `EVAL_MAX_USD` per run, so it is bounded only by the OpenAI project budget.
- **Render plan change during judging:** no plan changes after 2026-12-01 without the owner (change freeze, M4-07).
