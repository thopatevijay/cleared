---
title: "M2-GATE · Dispute Loop gate"
milestone: "M2 · Dispute Loop"
labels: [gate]
blocked_by: [M2-01, M2-02, M2-03, M2-04, M2-05, M2-06, M2-07, M2-08, M2-09, M2-10]
estimate: "1h"
resources: [PAYPAL_SANDBOX, OPENAI]
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14, P-21, P-24, P-46]
---

## Context
M2 delivers the product's central loop and the judge path that Stage One depends on (functional demo with real sandbox calls). The gate proves it from a **clean stack**, never a warm environment: chargeback → hold → pack → evidence filed → resolved → capture `COMPLETED` (PROJECT.md §8). A failure is a hard stop; nothing is deferred to pass it.

## Scope
- Clean state: `make down` (volumes removed), `make up`, migrations, seed; start web + worker locally
- Full landing checks on main
- Run the judge scenario end to end as a judge would (new anonymous demo workspace, no keys in the browser) with `e2e/judge-dispute.live.spec.ts`
- Demo-level checks, each verified on the resulting data:
  1. order + capture created with `custom_id = workspace_id`; `paypal_resource_owner` has order, capture and dispute for that workspace
  2. sandbox chargeback → dispute mirrored; capture `PENDING / BUYER_COMPLAINT` visible as a hold
  3. proof pack built: facts + verdicts, every citation passes the verbatim check, `unverifiable` where uncited
  4. dispute draft: notes ≤ 2000 chars, one compiled PDF < 10 MB, evidence type per the reason map
  5. seller approves the exact payload hash; execution re-fetched the dispute and found the action link; audit trail complete
  6. evidence filed (PayPal 2xx with debug_id)
  7. labelled "Simulate PayPal's decision (sandbox only)" used; dispute `RESOLVED`, `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`; UI says "Resolved; seller keeps the money (PayPal covered the case)"
  8. capture back to `COMPLETED`; hold shown released
- Negative checks: a second workspace sees none of the first's resources; kill switch on → execution refused without a PayPal call
- Record evidence (run ids, PayPal ids, timings, agent cost) in `docs/evidence/M2-GATE.md`

## Out of scope
- Production deploy run of the storyboard (M3-11); holds beyond the dispute hold (M3-01); evals and published accuracy (M4-02)

## Acceptance Criteria
- [ ] `make down && make up`, migrations and seed succeed from empty volumes
- [ ] `./scripts/landing-checks.sh` (full) passes
- [ ] `judge-dispute.live.spec.ts` passes on the live sandbox from the clean stack within 60 min
- [ ] SQL checks below return the expected rows (owner rows = 3; dispute RESOLVED; capture COMPLETED; action succeeded; audit rows ≥ 6 for the action)
- [ ] The isolation and kill-switch negative checks pass
- [ ] LLM spend for the run is within `LLM_WORKSPACE_CAP_USD` (from `agent_runs`)
- [ ] `docs/evidence/M2-GATE.md` lists the ids, timings and cost; no secret values

## Deliverables
- `docs/evidence/M2-GATE.md`
- Gate result comment on the M2-GATE issue

## Validation Gate
```bash
make down && make up
pnpm db:migrate && pnpm db:seed
./scripts/landing-checks.sh
(pnpm --filter ./apps/web run start > "$TMPDIR/m2-gate-web.log" 2>&1 &) ; (pnpm --filter ./apps/worker run start > "$TMPDIR/m2-gate-worker.log" 2>&1 &)
pnpm --filter ./apps/web exec playwright test e2e/judge-dispute.live.spec.ts --timeout=3600000 --reporter=line | tee "$TMPDIR/m2-gate-e2e.log"
psql "$DATABASE_URL" -c "select resource_type, count(*) from paypal_resource_owner group by 1;"
psql "$DATABASE_URL" -c "select status, outcome->>'outcome_code' from disputes order by updated_at desc limit 1;"
psql "$DATABASE_URL" -c "select status from payments order by synced_at desc limit 1;"
psql "$DATABASE_URL" -c "select kind, state from proposed_actions order by created_at desc limit 1;"
psql "$DATABASE_URL" -c "select sum(cost_usd) from agent_runs where created_at > now() - interval '2 hours';"
pnpm --filter ./apps/worker exec vitest run -t "isolation|kill switch"
! grep -rniE "seller won|you won" apps packages
```

## Handoff
- M3 starts from this gate: M3-01 (hold derivation), M3-06, M3-08, M3-09 are blocked on it
- M3-09 turns the scenario into the daily synthetic check; M3-11 repeats it on production
