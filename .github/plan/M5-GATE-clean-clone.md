---
title: "M5-GATE · Submission gate (clean clone)"
milestone: "M5 · Submission"
labels: ["gate"]
blocked_by: ["M5-CLEANUP", "M5-01", "M5-02", "M5-03"]
estimate: "1h"
resources: ["PAYPAL_SANDBOX"]
needs: []
---

## Context

This is the last check before the repo goes public and the entry is submitted. A judge will clone the public tree, read the README, open the hosted demo and watch the video. Any one failing (a broken clone, a dead link, a committed secret, a demo that doesn't run) can disqualify the entry or fail Stage One (PROJECT.md §1). So the gate runs from a **clean clone of `main` from GitHub**, on a fresh stack, and then runs the judge path **live on production**. It claims PAYPAL_SANDBOX for that live run.

## Scope

1. A fresh clone from GitHub of the M5-CLEANUP merge commit into `$TMPDIR`; `pnpm install --frozen-lockfile`
2. The full landing checks; no internal paths tracked; the citation check
3. `gitleaks detect` over the **full history** of the clone (the history becomes public too)
4. A fresh `make up`, migrations, seed; the full unit, integration and e2e suites on fixture replay; eval replay plus the README check
5. **Licence:** `LICENSE` is MIT, and GitHub detects it (`gh api … .license.spdx_id == MIT`)
6. **README:** `pnpm readme:check`; the Deploy to Render button resolves; the video link returns 200 (oEmbed)
7. **Devpost text:** `pnpm devpost:check`
8. **Production:**
   - Render serves the `main` HEAD commit
   - `/healthz` and `/readyz` are 200
   - the latest synthetic judge-path check passed
9. **Demo-level check (live):** Playwright runs the judge path on production as a fresh visitor:
   - "Try as demo seller" → card capture → sandbox chargeback → a `PENDING / BUYER_COMPLAINT` hold appears → pack and evidence → approve and file → the labelled sandbox decision → resolved → released
   - also loads the HI locale, and a dashboard check on a mobile viewport
   - the run's workspace is tagged and counted
10. **Owner list for M5-SUBMIT:** the repo is still private and the owner's public go-ahead is pending (a check, not an action)

## Out of scope

- Fixing failures (each reopens its owning ticket; the gate is a hard stop)
- Making the repo public and submitting (M5-SUBMIT)

## Acceptance Criteria

- [ ] Every command in the Validation Gate exits 0 from the clean clone. The output is attached to the issue with the commit SHA
- [ ] gitleaks reports 0 leaks across all commits
- [ ] The live judge path on production completes. The PayPal capture and dispute IDs are recorded on the issue, and the payment reaches `COMPLETED` after the labelled decision
- [ ] Render's live deploy commit equals `origin/main`
- [ ] GitHub reports the licence as `MIT`

## Deliverables

- The gate comment: SHA, outputs, the live run's PayPal IDs, and the go/no-go for M5-SUBMIT

## Validation Gate

```bash
set -euo pipefail
: "${PROD_URL:?set to the Render web URL (from .dev-refs.md)}"
tmp=$(mktemp -d "$TMPDIR/m5gate.XXXX"); gh repo clone thopatevijay/cleared "$tmp/c" && cd "$tmp/c"
pnpm install --frozen-lockfile
./scripts/landing-checks.sh
git ls-files | grep -E '^(\.github/plan/|PROJECT\.md$|WORKFLOW\.md$|CLAUDE\.md$|\.claude/(commands|agents)/)' && exit 1 || true
gitleaks detect --source . --log-opts="--all" --report-path "$TMPDIR/m5gate-gitleaks.json"
make down && make up && pnpm db:migrate && pnpm db:seed
pnpm test && pnpm --filter @cleared/web build && pnpm --filter @cleared/web exec playwright test --output "$TMPDIR/m5gate-pw"
pnpm eval --mode replay --set all --split test && pnpm eval:check-readme
gh api repos/thopatevijay/cleared --jq .license.spdx_id | grep -x MIT
pnpm readme:check && pnpm devpost:check
curl -sf "$PROD_URL/healthz" && curl -sf "$PROD_URL/readyz"
curl -sf "$PROD_URL/api/version" | jq -r .commit | grep -x "$(git rev-parse HEAD)"
E2E_BASE_URL="$PROD_URL" pnpm --filter @cleared/web exec playwright test e2e/judge-path.live.spec.ts e2e/i18n-hi.spec.ts --project=chromium --project=mobile --output "$TMPDIR/m5gate-live"
gh api repos/thopatevijay/cleared --jq .visibility | grep -x private
make down
```

## Handoff

- **M5-SUBMIT**: go/no-go, the live run IDs, and confirmation that the repo is still private, waiting for the owner's OK
