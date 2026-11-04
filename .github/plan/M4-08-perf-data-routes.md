---
title: "M4-08 · Data-route performance: server p95 + first-view SSR to meet the M4-04/M4-06 budgets"
milestone: "M4 · Trust & Global"
labels: ["backend", "frontend", "infra"]
blocked_by: []
estimate: "4h"
resources: []
needs: [P-01, P-02, P-03, P-05, P-46]
---

## Context

Two M4 budgets were measured and missed, with the same cause: data screens that are slow to read and slow to show.
- **M4-06 (#50) AC 1, production launch load:** 20 sessions × 10 min on 379d4e4, 0 errors, but overall p95 949 ms against 800. Seven routes are over: `GET /api/payments` 1,413, `/api/disputes/[id]` 1,170, `/api/packs/[id]` 968, `/api/holds` 940, page `/en/holds/[id]` 886, page `/en/payments/[id]/pack` 826, `/api/holds/[id]` 818. Server-side, `/api/disputes/[id]` is p95 851 ms on its own. The network floor (Pune → Oregon) is p95 337 ms. Evidence: `docs/evidence/load-report.md`.
- **M4-04 (#48) AC 5, Core Web Vitals:** Lighthouse median LCP is 2.8–8.2 s against 2.5 s, and dashboard first-load JS is 381 KB gzip against 200 KB. The branch predates the crypto-polyfill removal from #138 (about 124 KB). The largest element on the dashboard, pack, hold and dispute pages is drawn only after hydration and a client fetch. Evidence: `docs/evidence/perf-report.md` on PR #139.

The owner chose (2026-11-03) to fix both in one ticket rather than revise either budget. The thresholds are not changed. Rubric: Technological Implementation (scaling as measured numbers), Stage One (the demo is fast for judges).

## Scope

- **Base:** branch from `feat/m4-04-a11y-performance-03-11-2026` after merging `origin/main` into it (that brings in #138's polyfill fix and the later merges). This ticket's PR targets that branch (a stacked PR), so PR #139 carries the `lhci` tooling, budgets and fixes into `main` together.
- **Server: the database-reading routes:** `GET /api/payments`, `/api/disputes/[id]`, `/api/packs/[id]`, `/api/holds`, `/api/holds/[id]`, plus the page loaders for holds/[id] and payments/[id]/pack.
  - Measure each route's queries locally on a production-shaped dataset: seed volume at least what a judge's demo workspace holds after the storyboard, plus the 20 loadtest workspaces.
  - Fix with evidence: missing indexes (migration after 0019, via `EXPLAIN (ANALYZE, BUFFERS)` before and after), N+1 reads collapsed into joins or batched reads, columns trimmed to what the screen renders, and no per-request work that can be cached safely within a workspace.
  - Keep every authZ/ownership check and the `workspace_id` scoping. The M4-05 authZ route-coverage suite must stay green.
- **Client: the first view of each data screen** (dashboard, payments/[id]/pack, holds/[id], disputes/[id]):
  - The largest element is server-rendered from the first response (RSC data loading through the same server modules the API routes use; no duplicated query logic).
  - Client fetches are used only for refresh.
  - Keep zod and other heavy modules out of the first-load chunk where they aren't needed to render.
  - Stay under M4-05's nonce CSP (no inline script without the nonce; `e2e/csp.spec.ts` green). Keep Bryntum loaded at runtime from /vendor; never bundle it.
- **Re-measure:** local `pnpm lhci autorun` and `pnpm --filter @cleared/web analyze --json` from #139's tooling, plus a local server-side timing harness for the seven routes (p95 over the same session mix as `scripts/load/launch.ts`, run against the local production build).
- **The production re-measure is NOT in this ticket.** After merge and deploy, a separate short run (DEPLOY holder) repeats `pnpm load:launch` and closes M4-06 AC 1.

## Out of scope

- Changing any threshold or budget (owner decision: fix, don't revise)
- Render plan upgrades (owner only; if the numbers prove the plan is the limit, write it up with evidence instead)
- The Bryntum dark-mode watermark (owner decision on BL-01 6604837005) and the VoiceOver pass (P-54); both stay with M4-04
- Prompt or model changes (M4-02)

## Acceptance Criteria

- [ ] `pnpm lhci autorun` (#139's config) exits 0: median LCP ≤ 2.5 s on every audited route, and CLS/TBT still within budget
- [ ] Dashboard first-load JS ≤ 200 KB gzip (`pnpm --filter @cleared/web analyze --json`)
- [ ] The local server-timing harness shows p95 ≤ 400 ms server-side for each of the seven routes on the production-shaped dataset. That leaves room for the measured 337 ms network p95 inside 800 ms end to end. Before and after numbers are recorded per route
- [ ] Every new index is justified by an `EXPLAIN (ANALYZE, BUFFERS)` before/after in `docs/evidence/perf-report.md`
- [ ] Every existing test stays green: the authZ route-coverage suite, `e2e/csp.spec.ts`, the a11y matrix from #139, `pnpm i18n:check` and `landing-checks --fast`. No test is weakened
- [ ] The `perf-report.md` and `load-report.md` follow-up sections say what changed and what the production re-measure must show

## Deliverables

- Query and index changes under `packages/db/**` (migration `0020_*` if needed), server modules under `apps/web/src/server/**`, RSC loaders under `apps/web/app/**`
- `scripts/load/server-timing.ts` (or an extension of `scripts/load/launch.ts`) for the local server-side p95
- `docs/evidence/perf-report.md` and `docs/evidence/load-report.md` updates

## Validation Gate

```bash
export PORT_OFFSET=<n> DATABASE_URL=postgres://cleared:cleared@localhost:<5432+n>/cleared
make reset && pnpm db:seed && node packages/db/src/seed.ts --loadtest 20
pnpm --filter @cleared/web build
pnpm load:server-timing --routes payments,disputes-id,packs-id,holds,holds-id,page-holds-id,page-pack --p95 400
pnpm lhci autorun
pnpm --filter @cleared/web analyze --json   # dashboard first-load gzip ≤ 200 KB
pnpm --filter @cleared/web exec playwright test e2e/csp.spec.ts e2e/a11y.spec.ts
./scripts/landing-checks.sh --fast
make down
```

## Handoff

- **M4-04 (#48):** once this ticket's PR merges into its branch, PR #139's `lhci` CI job should be green and #139 can merge to `main`. #48 still waits on P-54 and the watermark decision.
- **M4-06 (#50):** after deploy, the DEPLOY holder re-runs `pnpm load:launch` (20 × 10 min) and `load:assert --p95 800 --err 0.005`. AC 1 closes on that run.
- **M4-GATE (#52):** re-checks both budgets from a clean clone.
