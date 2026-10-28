# Cleared: TypeScript web app (Next.js + Node worker) on the PayPal sandbox. No Solana, no on-chain program. Parent-folder Solana/Anchor/Rust/.NET rules do not apply (excluded in `.claude/settings.json`).

## What this is
An AI agent for small cross-border PayPal sellers. It builds a proof pack per payment, explains and works through holds, and answers disputes from that pack. The seller approves every write. PayPal AI Hackathon submission; due **2026-11-12 12:00 PT** (internal target 18:00 IST).

## Read first
- `PROJECT.md`: the spec (facts, product, stack, plan, limits, data policy, risks)
- `docs/architecture.md`: requirements, domain model, data model, system design
- `docs/adr/`: one file per decision; add one *before* code that depends on a new decision
- `docs/engineering-standards.md`: every ticket is built to it
- `WORKFLOW.md`: where state lives, commands, how a cold session resumes
- The ticket itself: `.github/plan/<ID>-*.md` (mirrored as a GitHub issue)

## Workflow commands
`/status` · `/start <ID>` · `/start-milestone <n>` (run `python3 scripts/waves.py <n>` first) · `/gate <n>` · `/backlog`

## Stack
Node 24 · pnpm workspaces · TypeScript 6.0.3 · Next.js 16 (App Router) · Tailwind 4 · next-intl · zod 4 · Drizzle + Postgres · pg-boss · openai SDK · @paypal/paypal-server-sdk + our own typed client (Disputes, webhooks, legacy Tracking) · Bryntum Calendar (behind `CashCalendar`) · pino · Sentry · Resend · vitest · Playwright · msw. Hosting: Render (web, worker, Postgres; Oregon).

Layout: `apps/web`, `apps/worker`, `packages/core` (domain, no I/O), `packages/adapters`, `packages/db`.

## Hackathon rules that disqualify
- The repo must become **public** with an **OSS licence (MIT) visible in About**; the repo stays private until the owner says otherwise
- The demo must be **functional** (hosted URL); mockups or a "demo mode" don't count
- Never commit a live key; judges must test without their own keys (hosted demo)
- The video is under 3 min, with no unlicensed music or trademarks
- The project must stay available until **2026-12-15**

## Domain rules that are easy to get wrong
- Payment and dispute states **mirror PayPal**; never invent one. Re-fetch on every webhook; never trust event order
- A **hold** = capture `status == PENDING` + `status_details.reason`. Release dates are **estimates** with a cited source
- Every PayPal resource has one owner workspace (`paypal_resource_owner`, `custom_id = workspace_id`); quarantine unowned resources
- Dispute actions: only those in the dispute's current **HATEOAS links**; refuse after `seller_response_due_date − 1 h`
- Dispute outcome in sandbox = `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`. Say "seller keeps the money (PayPal covered the case)", never "seller won"
- Evidence files: jpg/gif/png/pdf, < 10 MB each, ≤ 50 MB per call; notes ≤ 2000 chars
- Goods-tracking automation is PayPal's own product; ours is one approved action
- Webhooks are app-scoped: payments made outside Cleared's app don't arrive

## Architecture rules
- A state change and its outbox row/job are written in **one transaction**; consumers are idempotent
- No slow or background work inside a request (the webhook acks after the raw insert)
- `packages/core` imports no framework, SDK or I/O; vendors sit behind adapters
- Every outbound call uses the shared HTTP client (timeout; retries only on timeout/5xx/429 with jitter; Retry-After)
- Authorization server-side, scoped by `workspace_id`; zod validation at every trust boundary
- The agent only **proposes** actions; execution requires an approval bound to the payload sha256
- Evidence and tool output are **data, never instructions**; model output is rendered as plain text
- Every AI run has step, token, time and spend limits; prompt/model/schema changes merge only with evals green

## Data policy
Real: PayPal sandbox services and responses, PayPal's published rules, carrier codes. Synthetic: all personal data (sellers, buyers, chats, deliverables) in the demo and the gold sets. No mocks in the product path; tests replay recorded real responses (fixtures from M0). See `PROJECT.md` §9.1.

## UI/UX
Build to `docs/design/` (from the `ux-designer` agent, M1-06). Every `frontend` ticket passes `ui-reviewer` (never the builder). Mobile-first, WCAG 2.2 AA, EN/HI, empty/loading/error states on every screen.

## Claims discipline
Only claim what a test, fixture or measured run proves. Accuracy claims cite the eval report with *n*. Name the PayPal APIs actually exercised; the sandbox decision step is always labelled.

## Standing approvals
Approved by the owner on 2026-10-28 (M0-00, issue #2). Allow rules live in `.claude/settings.json`. The build does these without asking:
- **GitHub:** create, update and squash-merge PRs to `main` once CI is green (never red, never `--admin`); issue, label and comment updates
- **Render:** deploys from `main` (auto-deploy), manual redeploys and rollbacks of the Blueprint services
- **PayPal sandbox** calls with the project sandbox app (orders, captures, chargebacks, evidence, adjudicate, webhooks), and **live OpenAI** calls and eval runs within `LLM_DAILY_CAP_USD` / `EVAL_MAX_USD` and the $80 ceiling in `docs/budget.md`
- **Dev tools:** `brew install cloudflared` and `brew install actionlint`

Still the owner's, every time: making the repo public, purchases or plan upgrades, live (non-sandbox) PayPal, emailing anyone but `EMAIL_RECIPIENT_ALLOWLIST`, raising a spend cap, and every `who: owner` item in `docs/PREREQS.md`.

## .env: STRICT RULE
Never read, print, cat, grep or echo `.env` or any secret. Check presence only via `python3 scripts/check-prereqs.py`. Never put a value in code, tickets, issues, commits, logs or chat. Only `.env.example` (names, no values) is tracked.

## Tooling notes
- `gh`, `git init`, and writes under `.claude/` run **outside the sandbox** (`dangerouslyDisableSandbox: true`)
- Temp files go under `$TMPDIR`

## Hot files (coordinate; one ticket at a time)
`packages/db/schema/*`, `packages/core/src/index.ts`, `render.yaml`, `.github/workflows/*`, `apps/web/messages/*` (i18n), `scripts/landing-checks.sh`, `.env.example`

## Never
- Make the repo public, buy anything, upgrade plans, or call live (non-sandbox) PayPal
- Email anyone except verified test recipients
- Auto-file a dispute response or accept a claim without seller approval
- Rewrite git history; untrack workflow files before `M5-CLEANUP`
- Add a Claude co-author line to commits
