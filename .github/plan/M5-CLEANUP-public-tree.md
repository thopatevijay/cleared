---
title: "M5-CLEANUP · Public tree"
milestone: "M5 · Submission"
labels: ["docs", "owner"]
blocked_by: ["M5-01", "M5-02", "M5-03"]
estimate: "2h"
resources: []
needs: [P-01, P-02, P-03, P-05, P-57]
---

## Context

Judges reading the public repo should see the product, its architecture and its evidence, not the build workflow. During the build the workflow files must stay tracked, because `/start-milestone` and `/gate` worktrees only receive tracked files. So this ticket runs **last**, after every other build ticket (M5-01, M5-02, M5-03, and through them M4) and before M5-GATE, which then proves the public tree from a clean clone.

Files are **untracked, not deleted** (`git rm -r --cached` plus `.gitignore`), so the owner keeps them locally. History is **never rewritten**: issues, PRs and old commits stay as the visible record of how the product was built. Research, outreach, recon notes, `.prp/`, `.kickoff-state.md`, `.dev-refs.md` and review screenshots were gitignored from day one and never entered history.

## Scope

**Untrack and gitignore:**

| Path | Why |
|---|---|
| `.github/plan/` (tickets, `issue-map.json`, `prereqs.json`, `milestones.json`, `resources.json`) | Ticket sources; the GitHub issues hold the same content |
| `PROJECT.md`, `WORKFLOW.md`, `CLAUDE.md` | Internal spec and workflow; the system design is public in `docs/architecture.md` |
| `.claude/commands/`, `.claude/agents/` | Workflow commands and agent instructions |
| `scripts/waves.py`, `scripts/bootstrap_github.py`, `scripts/check-prereqs.py`, `scripts/check-plan.py` | Milestone and kickoff tooling |
| `docs/engineering-standards.md`, `docs/PREREQS.md`, `docs/budget.md` | Internal standards and owner checklists (unless cited, below) |

**Keep tracked:**

- Product code, tests, IaC (`render.yaml`), CI (`.github/workflows/`), `README.md`, `LICENSE`, `.env.example`, `.claude/settings.json`
- `docs/architecture.md`, `docs/adr/`, `docs/design/`, `docs/evidence/`, `docs/screenshots/`, `docs/security/`, `docs/operations/`, `docs/video/`, `docs/submission/`
- `packages/evals/gold/` and `fixtures/` (the evidence behind the measured claims)
- `scripts/landing-checks.sh`, `scripts/check-no-secrets.sh` (the clean-clone check runs them), and the product check scripts (`check-i18n`, `check-readme-claims`, `check-devpost`, `check-security-doc`, `check-runbook`, `load/`)
- Any file above that a tracked file cites: list it here, or repoint the citation to the issue. Known risk: ADRs or `docs/architecture.md` linking `docs/engineering-standards.md` or `PROJECT.md`; the docs mention "M0-07"-style ticket IDs, which stay as plain text (the issues are public)

**Decide and record on the issue (owner):** anything the owner wants kept public from the untrack list (for example `docs/engineering-standards.md` as evidence of process).

## Out of scope

- Rewriting history or removing anything from old commits
- Making the repo public (M5-SUBMIT, with the owner's go-ahead)
- README or Devpost wording (M5-01, M5-03)

## Acceptance Criteria

- [ ] `git ls-files` lists none of the untracked paths (output on the issue)
- [ ] Every repo path cited by a tracked file is itself tracked: the citation check prints nothing
- [ ] `./scripts/landing-checks.sh` passes on a clean clone of the merge commit
- [ ] CI is green on the merge commit
- [ ] File count before and after, and the owner's decisions, posted on the issue

## Deliverables

- `.gitignore` additions and the untracking commit; any repointed citations

## Validation Gate

```bash
set -euo pipefail
INTERNAL='^(\.github/plan/|PROJECT\.md$|WORKFLOW\.md$|CLAUDE\.md$|\.claude/(commands|agents)/|scripts/(waves|bootstrap_github|check-prereqs|check-plan)\.py$|docs/(engineering-standards|PREREQS|budget)\.md$)'
if git ls-files | grep -E "$INTERNAL"; then echo "internal paths still tracked"; exit 1; fi
git ls-files | wc -l
# every repo path cited in a tracked file must itself be tracked (a local untracked copy does not count)
missing=$(git grep -hoE '(docs|scripts|infra|fixtures|packages|apps|\.github)/[A-Za-z0-9_./-]+\.(md|ts|tsx|js|mjs|json|jsonl|ya?ml|sh|py)' \
  | sort -u | while read -r p; do git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || echo "$p"; done)
[ -z "$missing" ] || { printf 'MISSING:\n%s\n' "$missing"; exit 1; }
git grep -nE '\]\((\.\./)*(PROJECT|WORKFLOW|CLAUDE)\.md' && { echo "link to an untracked file"; exit 1; } || true
tmp=$(mktemp -d "$TMPDIR/cleanup.XXXX") && git clone -q . "$tmp/c" \
  && (cd "$tmp/c" && pnpm install --frozen-lockfile && ./scripts/landing-checks.sh)
```

## Handoff → M5-GATE, then M5-SUBMIT

Comment with the merge commit SHA, the file count before and after, and the owner's decisions. M5-GATE clones that commit from GitHub and proves the public tree.
