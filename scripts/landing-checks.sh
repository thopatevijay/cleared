#!/usr/bin/env bash
# The landing checks: ONE chain shared by /start Phase 6 and /start-milestone § 3d, so a manager's
# merge and a worker's merge are held to the same bar. The first failure stops the rest, and the
# secret scan runs first so a leak blocks landing exactly like a failed test.
# Edit per project (add its own checks at the bottom), never per run.
#
# Two levels:
#   ./scripts/landing-checks.sh          full: every workspace plus the slow project checks.
#                                        Standalone /start, the /start-milestone batch gate, CI.
#   ./scripts/landing-checks.sh --fast   only the npm workspaces this branch changed against
#                                        origin/main. /start-milestone workers, and re-runs after a
#                                        rebase or backlog fix. A root config change runs everything.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

# Private-from-day-one paths (research, outreach, recon notes, review screenshots, local state) are
# gitignored by /kickoff and must never be tracked. Workflow files are untracked later, by M<n>-CLEANUP.
if git ls-files | grep -E '^(docs/(research|outreach|recon)/|\.review/|\.prp/|\.dev-refs\.md$|\.kickoff-state\.md$)'; then
  echo "landing-checks: the private paths above are tracked; run 'git rm -r --cached' on them" >&2
  exit 1
fi

./scripts/check-no-secrets.sh

# pnpm workspaces (pnpm-workspace.yaml). --fast runs only the packages changed against origin/main,
# plus their dependants; a root config change runs everything.
if [ -f package.json ]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "")
  root_changed=0
  if [ -n "$base" ] && git diff --name-only "$base" | grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|eslint\.config\.[cm]?[jt]s)$'; then
    root_changed=1
  fi
  if [ "$FAST" = 1 ] && [ -n "$base" ] && [ "$root_changed" = 0 ]; then
    echo "landing-checks --fast: packages changed since $base (and dependants)"
    # `!{.}` drops the workspace root: a root-level change (fixtures/, docs/) would otherwise run its
    # `pnpm -r run test` alongside the filtered run, two suites on one database at once (M2-02).
    pnpm -r --filter "...[$base]" --filter '!{.}' --if-present run typecheck
    pnpm -r --filter "...[$base]" --filter '!{.}' --if-present run lint
    pnpm -r --filter "...[$base]" --filter '!{.}' --if-present run test
  else
    pnpm -r --if-present run typecheck
    pnpm -r --if-present run lint
    pnpm -r --if-present run test
  fi
else
  echo "landing-checks: no package.json yet (before M0-02 repo bootstrap): pnpm checks not applicable"
fi

# TS scripts outside the workspaces (spikes import the product adapters): typecheck so they do not rot.
if [ -f tsconfig.scripts.json ]; then
  pnpm exec tsc --noEmit -p tsconfig.scripts.json
fi

# Project-specific checks below. Guard a check that a later ticket creates with `if [ -x … ]; then …; fi` (never `[ … ] && …`: a false test as the last command fails the script) and say so.
# Put slow checks (emulators, e2e, full-stack runs) inside `if [ "$FAST" = 0 ]; then … fi`.

# --- Cleared project checks ---

# The ticket plan stays mechanically valid.
python3 scripts/check-plan.py >/dev/null || { python3 scripts/check-plan.py; exit 1; }

# The domain core imports no framework, SDK or I/O (ADR 0001). Guarded: packages/core is created in M1-01.
if [ -d packages/core/src ]; then
  if grep -rnE "from ['\"](next|react|pg|pg-boss|drizzle-orm|openai|@paypal/|resend|@sentry/|pino|node:fs|node:net|node:http|fs|http|https)['\"/]" packages/core/src; then
    echo "landing-checks: packages/core must not import frameworks, SDKs or I/O (ADR 0001)" >&2
    exit 1
  fi
fi

# Claims discipline (README and product copy only): the sandbox outcome is "seller keeps the money (PayPal covered the case)", never "seller won".
if git ls-files -- README.md apps packages | grep -E '\.(md|tsx?|json)$' | xargs grep -niE "seller (has )?won|won the dispute" 2>/dev/null; then
  echo "landing-checks: overclaim found (see CLAUDE.md claims discipline)" >&2
  exit 1
fi

# Design tokens (M1-06): tokens.css matches docs/design/tokens.json and every text pair meets WCAG AA.
if [ -f docs/design/tokens.json ]; then
  node scripts/design-tokens.mjs --check >/dev/null || { node scripts/design-tokens.mjs --check | grep -E "FAIL|design-tokens"; exit 1; }
fi

# Fixtures never carry credentials (recorded in M0 spikes). Guarded: fixtures/ is created in M0-04.
if [ -d fixtures ]; then
  if grep -rniE "(access_token\"?\s*:\s*\"A21|client_secret|Bearer [A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9]{20,})" fixtures; then
    echo "landing-checks: credential-shaped text in fixtures/" >&2
    exit 1
  fi
fi

if [ "$FAST" = 0 ]; then
  # Slow checks, added by later tickets: e2e on the core flow (Playwright), deterministic eval replay.
  if [ -f apps/web/playwright.config.ts ] && [ -n "${RUN_E2E:-}" ]; then
    pnpm --filter web exec playwright test
  fi
  if [ -x scripts/eval-replay.sh ]; then
    ./scripts/eval-replay.sh
  fi
fi
