---
title: "M4-GATE · Trust & Global gate"
milestone: "M4 · Trust & Global"
labels: ["gate"]
blocked_by: ["M4-01", "M4-02", "M4-03", "M4-04", "M4-05", "M4-06", "M4-07", "M4-08"]
estimate: "1h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-06, P-07, P-12, P-14, P-26]
---

## Context

M4 turns a working product into a trustworthy, global one: measured evals, Hindi, accessibility and performance budgets, security tests, a load test, and an operations plan for judging (PROJECT.md §8: "evals published; HI; a11y/perf budgets; security tests; load test"). Every claim in M5's README, video and Devpost text rests on these artefacts, so the gate proves them from a clean state, never from a warm environment.

## Scope

Run from a fresh worktree of `main`, with a fresh stack (`make down && make up`), migrations and seed:

1. The landing checks (full)
2. **Evals:** replay of all three sets offline. The report validates; the README block equals the report; every threshold is met in the report; the nightly live `eval` run on `main` is green
3. **Gold sets:** `pnpm eval:validate` (counts, spans, owner labels, second-model reviews)
4. **Hindi:** `pnpm i18n:check`, and the judge-path e2e in `hi` on fixture replay
5. **Accessibility and performance:** the axe, keyboard and reflow specs; Lighthouse CI budgets on the production build
6. **Security:** `pnpm test:security`, `pnpm audit --prod --audit-level high`, and gitleaks over full history
7. **Load:** `docs/evidence/load-report.md` exists and meets the targets; a 60 s local burst at 5/s re-checks ack p95 and 0 duplicates
8. **Retention and runbook:** the purge dry run with a fake clock; `pnpm runbook:check`
9. **Demo-level check:** the full judge path end to end on fixture replay (card capture → chargeback hold → pack → evidence → labelled sandbox decision → released) in EN and HI, keyboard-only in EN

## Out of scope

- Fixing failures inside the gate: a failure reopens the owning M4 ticket (the gate is a hard stop; nothing is deferred to pass)
- README, video, Devpost text (M5)

## Acceptance Criteria

> Amended by the owner on 2026-11-04 (#52, comment 6627675260): holds at the accepted baseline (the 0.95 miss is reported), the `eval replay` CI job on `main` instead of the removed scheduled run, Lighthouse report-only, and the production load p95 recorded as not met. The originals stay below.

- [ ] Every command in the Validation Gate exits 0 on a fresh stack. The output is attached to the issue
- [ ] `docs/evidence/eval-report.json` shows scope ≥ 0.90, extraction ≥ 0.90, explanations ≥ 0.95, citation verbatim 1.0 and adversarial pass 1.0, each with *n*
- [ ] The latest scheduled `eval` workflow run on `main` concluded `success` (`gh run list`)
- [ ] The judge-path e2e passes in EN and HI, and keyboard-only in EN
- [ ] The load report targets are met, and the 60 s local burst re-check passes

## Deliverables

- The gate comment on the issue: commit SHA, command outputs, report links, pass/fail per check

## Validation Gate

```bash
set -euo pipefail
wt="$TMPDIR/m4gate.$$"; git worktree add "$wt" origin/main && cd "$wt"
pnpm install --frozen-lockfile
make down && make up && pnpm db:migrate && pnpm db:seed
./scripts/landing-checks.sh
pnpm eval:validate
pnpm eval --mode replay --set all --split test
pnpm eval:check-readme
# the report's real fields (sets.<k>.accuracy.rate, sets.scope.verbatim.rate, adversarial.pass); holds is
# checked against the owner-accepted baseline (amended AC, #52 comment 6627675260) and its 0.95 miss printed
node -e 'const r=require("./docs/evidence/eval-report.json"),s=r.sets,ok=(c,m)=>{if(!c){console.error("FAIL "+m);process.exitCode=1}};for(const k of ["scope","extraction"])ok(s[k].accuracy.rate>=.9&&s[k].accuracy.n>0,k);ok(s.scope.verbatim.rate===1&&s.scope.verbatim.n>0,"citation verbatim");ok(r.adversarial.pass===true,"adversarial");const h=s.holds;ok(h.accuracy.rate>=10/16&&h.fact_accuracy.rate>=58/64&&h.rule_ok.rate===1&&h.language_ok.rate===1&&h.pair_parity.rate===1&&h.forbidden_claims===0,"holds baseline");console.log("holds "+h.accuracy.k+"/"+h.accuracy.n+(h.accuracy.rate>=.95?" ≥ 0.95":" MISS (≥ 0.95) · accepted (#46)"))'
# the nightly scheduled run was removed for budget (#46): the `eval replay` CI job on main is the check
gh api 'repos/{owner}/{repo}/commits/main/check-runs' --jq '[.check_runs[]|select(.name=="eval replay")][0].conclusion' | grep -x success
pnpm i18n:check
pnpm --filter @cleared/web build
# judge path: HI in i18n-hi.spec.ts, keyboard-only EN in keyboard-judge-path.spec.ts (there is no judge-path.spec.ts)
pnpm --filter @cleared/web exec playwright test e2e/i18n-hi.spec.ts e2e/a11y.spec.ts e2e/keyboard-judge-path.spec.ts e2e/reflow.spec.ts --output "$TMPDIR/m4gate-pw"
pnpm lhci autorun --upload.target=filesystem --upload.outputDir="$TMPDIR/m4gate-lhci"
pnpm test:security
pnpm audit --prod --audit-level high
gitleaks detect --source . --log-opts="--all" --report-path "$TMPDIR/m4gate-gitleaks.json"
test -s docs/evidence/load-report.md
# 60 s local burst at 5/s = 300 signed events (there is no --seconds flag) against a NODE_ENV=test stack on
# the seeded database (the events' custom_id is the seed workspace); docs/evidence/load-report.md "How to re-run"
make down && make up && pnpm db:migrate && pnpm db:seed
( source scripts/load/local-env.sh
  pnpm build
  NODE_ENV=test pnpm start:all > "$TMPDIR/m4gate-stack.log" 2>&1 & stack=$!
  trap 'kill "$stack" 2>/dev/null || true' EXIT
  until curl -sf "$APP_BASE_URL/healthz" >/dev/null; do sleep 2; done
  pnpm load:burst --target "$APP_BASE_URL" --rate 5 --count 300 --out "$TMPDIR/m4gate-burst.json" )
pnpm load:assert "$TMPDIR/m4gate-burst.json" --ack-p95 500 --dup 0 --dlq 0
FAKE_NOW=2026-12-22T00:01:00Z pnpm --filter @cleared/worker exec tsx src/jobs/retention-purge.ts --dry-run
pnpm runbook:check
cd - && git worktree remove --force "$wt"
```

## Handoff

- **M5-01** starts from the verified reports: `docs/evidence/{eval-report,load-report,a11y-report,perf-report}.md` and `docs/security/threat-model.md`
- The `/gate` post-gate sweep worker takes any BL-01 items raised here
