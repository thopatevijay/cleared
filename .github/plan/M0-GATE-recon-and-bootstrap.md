---
title: "M0-GATE · Recon & Bootstrap gate: prerequisites, CI green, fixtures recorded, Render deploy live"
milestone: "M0 · Recon & Bootstrap"
labels: ["gate"]
blocked_by: ["M0-00", "M0-01", "M0-02", "M0-03", "M0-04", "M0-05", "M0-06", "M0-07", "M0-08", "M0-09"]
estimate: "1h"
resources: []
needs: []
---

## Context

M1 builds the walking skeleton on everything M0 proves: the owner's prerequisites, the repo and CI,
a resettable local stack, real PayPal and OpenAI behaviour captured as fixtures, and a live Render
pipeline. If any of that is assumed instead of proven, M1's webhook-driven payment on the deployed
dashboard fails late with no slack. This gate proves M0 from a **clean state**, never a warm one.

## Scope

Run from a fresh clone of `main` into `$TMPDIR`, with `make reset` (clean Postgres, migrations; no
seed exists yet: M1-02 adds it). Check, in order:

1. Prerequisites: `python3 scripts/check-prereqs.py` exits 0 (every required item present)
2. Plan: `python3 scripts/check-plan.py` clean; every ticket has `needs:`
3. Repo: clean install + `./scripts/landing-checks.sh` (full); CI green on `main`; repo private; MIT detected
4. Local stack: `make reset` ≤ 2 min; migrations applied; pg-boss schema present; transactional-enqueue test passes
5. Fixtures: present for orders, tracking, disputes (every state seen), webhooks (management,
   simulator, deliveries) and OpenAI (extract, scope pass 1 and 2); all scrubbed; replay tests pass
   **offline** (unhandled requests fail)
6. Render: `/healthz` returns 200 with the `main` commit; the worker logged `worker ready`
7. Evidence docs for M0-02…M0-09 exist; measured numbers copied into the gate comment
8. Owner items: M0-00 standing approvals recorded; M0-01 "sent" comments present

## Out of scope

- Fixing anything found here (the owning ticket reopens, or BL-01; features are never deferred to pass)
- Live PayPal or OpenAI calls (the gate uses fixtures; the Render check is a read-only GET)

## Acceptance Criteria

- [ ] Every `blocked_by` ticket is closed
- [ ] `python3 scripts/check-prereqs.py` exits 0
- [ ] `python3 scripts/check-plan.py` exits 0
- [ ] Fresh clone: `pnpm install --frozen-lockfile` and `./scripts/landing-checks.sh` pass
- [ ] CI on `main`: latest run `success`
- [ ] `make reset` ≤ 120 s; `__drizzle_migrations` and `pgboss` schema present
- [ ] Fixture counts meet each spike's minimum; scrub greps return 0; replay tests pass with the network blocked
- [ ] `$RENDER_WEB_URL/healthz` → 200 with `commit == origin/main`
- [ ] `OPENAI_MODEL_SMALL` / `OPENAI_MODEL_LARGE` pinned; measured cost per pack recorded
- [ ] Gate comment posted with the numbers table: install, local check, CI, reset, deploy time, fixture counts, cost and latency per pack, webhook delivery latency

## Deliverables

- Gate comment on this issue (numbers table + AC results); screenshots, if any, in `.review/M0-GATE/`

## Validation Gate

```bash
D="$TMPDIR/m0-gate" && rm -rf "$D" && git clone -q "$(git remote get-url origin)" "$D" && cd "$D"
cp "$OLDPWD/.env" .env 2>/dev/null || true          # presence only; never printed
python3 scripts/check-prereqs.py; echo "prereqs exit $?"
python3 scripts/check-plan.py
pnpm install --frozen-lockfile
time make reset
./scripts/landing-checks.sh
gh run list --branch main --workflow ci.yml -L 1 --json conclusion -q '.[0].conclusion'    # expect success
gh repo view --json visibility,licenseInfo -q '.visibility + " " + .licenseInfo.key'       # expect PRIVATE mit
for d in paypal/orders paypal/tracking paypal/disputes paypal/webhooks/management paypal/webhooks/simulator paypal/webhooks/deliveries openai/extract openai/scope-pass1 openai/scope-pass2; do
  printf '%-32s %s\n' "$d" "$(find fixtures/$d -name '*.json' | wc -l)"; done
grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' fixtures/ | grep -vc '@example\.test$'   # expect 0
grep -rniE '(client_secret|Bearer [A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,})' fixtures/ | wc -l    # expect 0
pnpm --filter @cleared/adapters test && pnpm --filter @cleared/core test                          # replay, offline-only handlers
grep -E '^OPENAI_MODEL_(SMALL|LARGE)=.+' .env.example | wc -l                                       # expect 2
RENDER_WEB_URL=$(grep -E '^RENDER_WEB_URL=' .env.example | cut -d= -f2-)
test "$(curl -fsS "$RENDER_WEB_URL/healthz" | jq -r .commit)" = "$(git rev-parse origin/main)" && echo "render live on main"
ls docs/evidence/m0-0{2,3,4,5,6,7,8,9}-*.md
```

## Handoff

- **PASS:** close with `status:done`; run the post-gate backlog sweep (`/gate` step 8); next: `/start-milestone 1` (M1-01, M1-06 first)
- **FAIL:** stays open with `status:blocked`; the failing ACs and owning tickets listed; cause logged to BL-01; no M1 ticket starts
- **M1-GATE:** reuses this clean-clone procedure and adds the seed
