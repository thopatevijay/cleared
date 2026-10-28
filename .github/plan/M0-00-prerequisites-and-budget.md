---
title: "M0-00 · Prerequisites and budget (owner): every service, key, registration, tool and cost, before any build"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "meta", "owner", "blocker-risk", "critical"]
blocked_by: []
estimate: "2h"
resources: []
needs: []
---

## Context

`/start-milestone` is meant to run for hours without the owner. It fails when a worker reaches a
step that needs something only the owner can provide (an API key in `.env`, a console toggle, an
OAuth scope, a paid plan) and waits there unseen. This ticket finds **every** such dependency up
front, so the owner can provide them in one sitting and every later ticket can check its own
prerequisites in its first minute (`/start` Phase 1, `scripts/waves.py` holds).

Rubric link: Stage One is pass/fail on a **functional, hosted** demo that stays testable until
2026-12-15. A missing key, an unpaid Render plan or an expired trial during judging fails it.

This ticket **gathers and decides**. It installs, enables, registers and buys nothing.

## Scope

Read **every ticket in `.github/plan/`** plus `PROJECT.md` (§4 stack, §5 services and spend) and inventory:

1. **Cloud services and APIs** per ticket, with region or plan constraints (Render Oregon, starter plans)
2. **Accounts and registrations** (Render, OpenAI, Resend, Sentry, Bryntum, PayPal developer, YouTube,
   Devpost), and their approval lead times
3. **Credentials and where each lives**: local auth, OAuth scopes (`gh` needs `workflow` to push
   `.github/workflows/`), secrets (Render env var name + `.env` key name from `.env.example`). Who
   creates each, and how. **Never record a value**
4. **Console-only steps** no CLI can do, with the exact console path
5. **Local tools** with minimum versions (Node 24, pnpm 12, Docker daemon, Python 3, gitleaks,
   psql, ffmpeg for the video gate, a tunnel for M0-06, browsers for Playwright)
6. **Purchases and subscriptions**: buy / don't buy, and why
7. **Running costs**: per service at our scale, for development **and** for the judging window
   (always-on web + worker, Postgres, model spend for evals, email, error tracking). Free-tier
   status and expiry (Render free Postgres expires after 30 days: not usable)
8. **Owner decisions** needed before the build (budget ceiling, Resend domain, Bryntum timing)
9. **Standing approvals**: every routine owner action the plan will hit repeatedly. The owner
   pre-approves or declines each class once; approved classes become allow rules in
   `.claude/settings.json` and a list under "Standing approvals" in `CLAUDE.md`, so the build never
   pauses on them. Declined ones stay on the owner list, batched one sitting per milestone

Make it enforceable:

- `.github/plan/prereqs.json` (the source; shape documented in `scripts/check-prereqs.py`), each
  item with a `verify` command that proves presence **without printing a value**
- `docs/PREREQS.md` rendered from it: `python3 scripts/check-prereqs.py --render`
- `docs/budget.md`: cost table, assumptions, development total, judging-window total (through
  2026-12-15), the ceiling the owner approves, and the alerts that enforce it (OpenAI project
  budget, `LLM_DAILY_CAP_USD`, `LLM_WORKSPACE_CAP_USD`)
- `needs: [P-..]` frontmatter on **every** ticket (empty list allowed), then re-sync issues
  (`python3 scripts/bootstrap_github.py`)
- An **owner checklist** comment on this issue: everything only the owner can do, in dependency
  order, groupable into one sitting

## Known so far

From `/kickoff` A3 (read-only check, 2026-10-28) and Approval 3. Verify, do not assume.

| Item | Finding | Owner action |
|---|---|---|
| Node / npm / pnpm | v24.22.1 / 11.19.1 / 12.15.0 | none |
| Python | 3.15.2 | none |
| Docker | CLI 29.1.3; **daemon not running** | **start the Docker daemon** (needed by M0-03 onwards) |
| git / gh | 2.56.0 / 2.103.3, logged in as thopatevijay, scopes include `repo`, `workflow` | none |
| Vercel CLI | logged in (not used: hosting is Render) | none |
| Render CLI | not installed | optional (`brew install render`); Render account needed regardless |
| Secret scanner | gitleaks 8.30.1 (trufflehog absent) | none |
| ffmpeg / psql / jq | 9.0.2 / 18.6 / 1.8.2 | none |
| Chrome | installed; claude-in-chrome connected (owner's personal profile) | none |
| Tunnel for M0-06 | neither `cloudflared` nor `ngrok` installed | allow the M0-06 worker to `brew install cloudflared` (quick tunnel, no account) |
| AI key | no `OPENAI_API_KEY` in env | **provide an OpenAI key** (owner's choice of provider, Approval 3) → `.env` + Render env `OPENAI_API_KEY`; set a project budget in platform.openai.com → Settings → Limits |
| PayPal sandbox | REST app works: OAuth, Orders, captures, tracking, disputes OK; Payment Review on (PENDING_REVIEW holds); Business + Personal sandbox accounts exist | **Transaction Search scope missing** from the token: create a **fresh sandbox app** with Transaction Search ticked (developer.paypal.com → Apps & Credentials → Sandbox → Create App → Features), then put its credentials in `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` |
| Resend | not set up | create an account + key → `RESEND_API_KEY`, `EMAIL_FROM`. **Decision:** the free tier sends only to the owner's own address until a domain is verified; verify a domain (which?) or accept owner-only email for the hackathon |
| Sentry | not set up | create a project (free) → `SENTRY_DSN` |
| Render | not set up | account + **payment method**; web + worker + Postgres starter ≈ **$20/mo through 2026-12-15**; connect the GitHub repo (private) to Render (M0-08) |
| Bryntum | trial not started (start on or after 2026-11-01 so it covers 2026-12-15) | send the **permission request** (M0-01); decision date **2026-11-04**. Decide whether M0-09's registry login before Nov 1 starts the trial clock |
| Review-hold pool | PENDING_REVIEW needs a buyer approval in the browser | **owner approves a few PENDING_REVIEW payments as the sandbox buyer** (M3-10), ~24 h before the video |
| Video | — | **owner records the voice-over** (M5-02) |
| Solana module | n/a (nothing on-chain) | none |

**Standing approvals proposed at Approval 3** (owner confirms or declines each here):
- merge green PRs to `main`
- Render deploys from `main`
- PayPal **sandbox** calls (orders, captures, chargebacks, evidence, adjudicate) with the project sandbox app
- live eval runs within the LLM cap (`LLM_DAILY_CAP_USD`)
- `gh` issue / label / comment updates

**Never without the owner:** making the repo public, purchases or plan upgrades, live (non-sandbox)
PayPal, emailing non-test recipients.

## Out of scope

- Doing any of the owner's actions, installing tools, enabling services
- Changing any ticket's scope (only add `needs:`); a ticket that looks wrong goes to BL-01
- Sending the Bryntum / organiser / Discord messages (M0-01)

## Acceptance Criteria

- [ ] Every ticket file read; each prerequisite lists the tickets that need it
- [ ] Every credential says where it lives (`.env` key and Render env name) and contains **no value**
- [ ] Every console-only step has an exact console path
- [ ] `docs/budget.md` has development and judging-window totals with assumptions, and the
      purchases decision (Render starter ×3 yes; Resend / Sentry / Bryntum no purchase)
- [ ] `check-prereqs.py` runs every item, exits non-zero while a required item is missing, and
      prints no secret (run with a canary value set and grep the output for it)
- [ ] Every ticket has a `needs:` field; issues re-synced
- [ ] Owner checklist comment posted
- [ ] Standing approvals decided by the owner, recorded on this issue, and the approved classes
      present as allow rules in `.claude/settings.json` and listed in `CLAUDE.md` "Standing approvals"

## Deliverables

- `.github/plan/prereqs.json`, `docs/PREREQS.md`, `docs/budget.md`
- `needs:` frontmatter on every `.github/plan/*.md`
- `CLAUDE.md` "Standing approvals" section; `.claude/settings.json` allow rules

## Validation Gate

```bash
python3 scripts/check-prereqs.py --render; echo "exit $?"   # non-zero until the owner finishes
python3 scripts/check-prereqs.py --json | jq 'length'
grep -L '^needs:' .github/plan/*.md | wc -l                  # expect 0
CANARY_SECRET=canary-value-123 python3 scripts/check-prereqs.py 2>&1 | grep -c canary-value-123   # expect 0
python3 scripts/check-plan.py
./scripts/check-no-secrets.sh
```

## Handoff → every ticket with a non-empty `needs:`, and the M0 gate

Comment: the owner checklist, the approved budget ceiling, and which `P-` ids each downstream ticket
needs. Post on M0-GATE that its validation must include `python3 scripts/check-prereqs.py`.
M0-01 needs the Bryntum timing decision; M0-08 needs Render payment + repo connection; M0-07 needs
the OpenAI key and budget; M0-04/05/06 need the fresh sandbox app credentials.
