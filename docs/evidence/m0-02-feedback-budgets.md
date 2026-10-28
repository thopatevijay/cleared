# M0-02 · Feedback budgets

Measured 2026-10-28 on the M0-02 branch (5 workspace packages, 151 installed packages). These are the baseline a later ticket must not regress (engineering standard: local check ≤ 2 min, PR CI ≤ 5 min).

| Loop | Measured | Budget | How |
|---|---|---|---|
| Cold install (clean clone, **empty** pnpm store) | **23.7 s** | none set | `pnpm install --frozen-lockfile --store-dir <empty>` on macOS, Node 24.22.1, pnpm 12.15.0 |
| Re-install (lockfile unchanged) | 1.1 s | none set | `pnpm install --frozen-lockfile`, second run |
| First `pnpm check` in a fresh clone | 5.3 s | ≤ 2 min | typecheck + lint + test across all five packages |
| Warm local check (`pnpm check`) | **3.4 s** | ≤ 2 min | second run |
| PR CI wall time, cache miss | **40 s** | ≤ 5 min | run [40729250015](https://github.com/thopatevijay/cleared/actions/runs/40729250015): landing checks 34 s ∥ gitleaks + audit 20 s |
| PR CI wall time, cache hit | **37 s** | ≤ 5 min | run [40729746677](https://github.com/thopatevijay/cleared/actions/runs/40729746677): landing checks 33 s ∥ gitleaks + audit 12 s |

## pnpm cache

- Run 40729250015: `Cache saved with the key: node-cache-Linux-x64-pnpm-5510f425…` (the first run on the lockfile)
- Run 40729746677: `Cache hit for: node-cache-Linux-x64-pnpm-5510f425…`, `Cache Size: ~136 MB`, `Cache restored successfully`

The key is `actions/setup-node` with `cache: pnpm` and `cache-dependency-path: pnpm-lock.yaml`, so it changes only when the lockfile does.

## Failure modes proven

| Probe | Result |
|---|---|
| Lint error: an un-awaited promise in `packages/core` | `pnpm check` exit 1: `@typescript-eslint/no-floating-promises` (plus `require-await`) |
| Type error: `const n: number = "not a number"` in `packages/core` | `pnpm check` exit 1: `TS2322: Type 'string' is not assignable to type 'number'` |
| Planted fake GitHub-token-shaped key on a throwaway branch (PR #63) | run [40729414046](https://github.com/thopatevijay/cleared/actions/runs/40729414046) failed: gitleaks `leaks found: 1`; `check-no-secrets: FAIL` (token pattern). PR closed, branch deleted locally and remotely, and local `gitleaks --log-opts=--all` clean again |

Both probe files were removed after the run. The planted value was random, never a real credential. GitHub keeps closed PR #63's head commit (`refs/pull/63/head`), so the fake string stays visible in that PR's history.

## CI shape

- `.github/workflows/ci.yml`: two parallel jobs on `pull_request` and push to `main`. Actions are pinned to commit SHAs. The gitleaks 8.30.1 binary is pinned and checksum-verified
  - **landing checks**: `pnpm install --frozen-lockfile`, then `./scripts/landing-checks.sh` (full)
  - **gitleaks + audit**: `gitleaks detect --log-opts=--all` over the full history (`fetch-depth: 0`), then `pnpm audit --prod --audit-level high`
- No repository secrets and no live vendor calls
- Actions minutes (BL-01): superseded PR runs are cancelled, and markdown-only PRs skip CI (ticket files under `.github/plan/` still run). Pushes to `main` always run in full
