---
title: "M0-02 · Repo bootstrap: pnpm workspaces, TS 6.0.3, eslint/prettier, vitest, CI with pnpm cache, gitleaks, MIT, feedback budgets measured"
milestone: "M0 · Recon & Bootstrap"
labels: ["infra"]
blocked_by: ["M0-00"]
estimate: "5h"
resources: []
needs: [P-01, P-02, P-03, P-05, P-06, P-08]
---

## Context

Every later ticket is built and proven on this skeleton, and every one pays its feedback loop
(engineering standard: local check ≤ 2 min, PR CI ≤ 5 min). Technological Implementation is judged
partly from the repo: a typed monorepo with CI, a secret scan and an MIT licence visible in About
(a disqualifier if missing). ADR 0001 (modular monolith) and ADR 0014 (delivery) fix the layout.

## Scope

- Default branch `main` (the local repo starts on `master`; rename before the first push). Push to the
  private repo `thopatevijay/cleared`; never change its visibility
- Root: `package.json` (`"packageManager": "pnpm@12.15.0"`, `"engines": {"node": ">=24"}`),
  `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `.nvmrc` (24), `tsconfig.base.json` (strict,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESM, `moduleResolution: bundler`),
  `eslint.config.js` (flat config, typescript-eslint, no-floating-promises, no `any`),
  `.prettierrc`, `vitest.workspace.ts` (or the vitest 5 equivalent)
- Re-verify every version in `PROJECT.md` §4 on npm today (`npm view <pkg> version`) and pin exact
  versions. TypeScript stays **6.0.3** while typescript-eslint requires `<6.1.0`. Record any change
  in `PROJECT.md` §4 with the date
- Workspace packages with a placeholder entry, a `typecheck`, `lint` and `test` script and one
  trivial passing test each: `apps/web` (`@cleared/web`, Next 16 App Router, one page),
  `apps/worker` (`@cleared/worker`, Node entry that logs and exits 0 in `--dry-run`),
  `packages/core` (`@cleared/core`, no dependencies), `packages/adapters` (`@cleared/adapters`),
  `packages/db` (`@cleared/db`). Internal deps via `workspace:*`
- Root scripts: `pnpm check` (= typecheck + lint + test across the workspace), `pnpm format`
- `.github/workflows/ci.yml`: on PR and push to `main`; Node 24 via `actions/setup-node` with the
  pnpm store cache keyed on `pnpm-lock.yaml`; `pnpm install --frozen-lockfile`;
  `./scripts/landing-checks.sh` (full: secrets, plan check, typecheck, lint, test, project checks);
  gitleaks over the full history (pinned binary or action version); `pnpm audit --prod --audit-level high`.
  No live PayPal or OpenAI calls in CI, ever (fixture replay only; no repository secrets needed)
- `LICENSE` (MIT) is already present: keep it, and confirm GitHub detects it (`gh repo view --json licenseInfo`)
- Measure the feedback budgets and write them down: cold install, warm `pnpm check`, CI wall time
  (from `gh run view`); if one is over budget, fix it here (cache, parallel jobs) before closing

## Out of scope

- Postgres, compose, Drizzle, pg-boss, `Makefile` (M0-03)
- The shared HTTP client, fixtures and replay helper (M0-04)
- `render.yaml` and `/healthz` (M0-08)
- Domain code in `packages/core` (M1-01); the design system (M1-06)
- Playwright e2e setup (added with the first core-flow test, M1-07)

## Acceptance Criteria

- [ ] `pnpm install --frozen-lockfile` succeeds from a clean clone on Node 24
- [ ] `pnpm check` passes and runs typecheck, lint and test in all five workspace packages
- [ ] `./scripts/landing-checks.sh` passes locally (full and `--fast`)
- [ ] A deliberate lint error and a deliberate type error each fail `pnpm check` (shown, then reverted)
- [ ] CI is green on `main` and on a PR; the second run reports a pnpm cache hit
- [ ] gitleaks and `pnpm audit` run in CI; a planted fake key on a throwaway branch fails CI (branch deleted after)
- [ ] `gh repo view --json licenseInfo` reports MIT; the repo is still private
- [ ] `docs/evidence/m0-02-feedback-budgets.md` lists measured cold install, warm local check (≤ 2 min), and PR CI (≤ 5 min)
- [ ] `PROJECT.md` §4 versions match `package.json` pins (re-verified today)
- [ ] **Root script contract** in the root `package.json`, so every later ticket's commands resolve. Each alias delegates to its workspace script once that exists (`--if-present`):
  - `db:migrate` → `pnpm --filter @cleared/db run migrate`
  - `db:seed` → `pnpm --filter @cleared/db run seed`
  - `db:count` → `pnpm --filter @cleared/db run count`
  - `start:all` → web + worker
  - `test:security` → `pnpm -r --if-present run test:security`
  - `eval`, `eval:validate`, `eval:check-readme`, `eval:draft`, `eval:report`, `eval:review`, `eval:label` → `pnpm --filter @cleared/evals run <same>` (filled by M4-01/M4-02)

  `pnpm run` lists them all.

## Deliverables

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json`,
  `eslint.config.js`, `.prettierrc`, vitest workspace config
- `apps/web/`, `apps/worker/`, `packages/core/`, `packages/adapters/`, `packages/db/` skeletons
- `.github/workflows/ci.yml`
- `docs/evidence/m0-02-feedback-budgets.md`; `PROJECT.md` §4 (versions)

## Validation Gate

```bash
git branch --show-current                                          # expect main
D="$TMPDIR/m0-02-clone" && rm -rf "$D" && git clone -q "$(git remote get-url origin)" "$D"
( cd "$D" && time pnpm install --frozen-lockfile && time pnpm check )
pnpm -r ls --depth -1 --json | jq -r '.[].name' | sort             # the five @cleared/* names (+ root)
./scripts/landing-checks.sh && ./scripts/landing-checks.sh --fast
gh run list --branch main --workflow ci.yml -L 1 --json conclusion -q '.[0].conclusion'   # expect success
gh repo view --json visibility,licenseInfo -q '.visibility + " " + .licenseInfo.key'      # expect PRIVATE mit
gitleaks detect --no-banner --redact --log-opts="--all"
```

## Handoff

- **M0-03, M0-04, M0-07, M0-08, M0-09:** build inside these packages; use `pnpm check` and the CI as-is
- **Everyone:** package names `@cleared/{web,worker,core,adapters,db}`; the measured budgets in
  `docs/evidence/m0-02-feedback-budgets.md` are the baseline a later ticket must not regress
- **M0-GATE:** CI green on `main`
