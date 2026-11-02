# Workflow

## Where state lives
| What | Where |
|---|---|
| Tickets (source) | `.github/plan/*.md`; mirrored to GitHub issues by `scripts/bootstrap_github.py` (`issue-map.json` holds the mapping) |
| Milestones | `.github/plan/milestones.json` → GitHub milestones with due dates |
| Shared resources | `.github/plan/resources.json` (`DEPLOY`, `PAYPAL_SANDBOX` exclusive; `OPENAI` budgeted) |
| Prerequisites | `.github/plan/prereqs.json` (M0-00); rendered to `docs/PREREQS.md`; checked by `scripts/check-prereqs.py` |
| Budget | `docs/budget.md` (M0-00) |
| Progress | GitHub issues and PRs (one PR per ticket) |
| Kickoff decisions | `.kickoff-state.md` (private) and `docs/adr/` (public) |

## Commands
- `/status`: zero-context summary: done, in flight, blocked, risks, the owner list
- `/start <ID>`: one ticket end to end (prerequisite check, PRP, implement, verify every AC, landing checks, design review for `frontend`, PR, backlog pass, merge, handoff)
- `/start-milestone <n>`: run `python3 scripts/waves.py <n>` first; a manager plus one worktree worker per ticket, in parallel waves
- `/gate <n>`: the milestone gate from a clean state (fresh stack, migrations, seed); the last gate runs after `M5-CLEANUP` from a clean clone
- `/backlog`: log and triage `BL-01` entries

## Running Validation Gates from a worktree
Gates are written to run verbatim from a fresh shell. Two things make that work in a parallel worktree:
- **Local stack.** Export your offset and URL once, before the first gate line:
  `export PORT_OFFSET=<n> DATABASE_URL=postgres://cleared:cleared@localhost:$((5432 + <n>))/cleared`.
  The Makefile reads `PORT_OFFSET` from the environment (`?=`), so a bare `make reset` in the gate
  then binds `5432 + n` and never touches the manager's 5432; the `pnpm … test` lines that follow use
  the same `DATABASE_URL`. Compose names the project after the worktree folder, so `make reset` drops
  only your own volume.
- **Live lines (PayPal credentials).** Node 24 refuses `--env-file` inside `NODE_OPTIONS` (exit 9),
  and a worktree has no `.env` (it must not get one). Put the live lines verbatim in a file and run
  them under a parent that loads the main checkout's `.env` by path, so the credentials are inherited
  and never read or printed:
  `node --env-file=<main checkout>/.env -e 'require("node:child_process").execFileSync("bash", process.argv.slice(1), {stdio:"inherit"})' gate-lines.sh`.
  Variables already in your shell win over the file (Node's `--env-file` never overrides them), so the
  exported `DATABASE_URL` above still points at your own stack.

## Test conventions
- **Skips in CI are live tests only.** CI runs with `REQUIRE_DB=1`, so a DB-dependent test fails
  instead of skipping: the DB skip count is always 0. CI has no PayPal or OpenAI credentials, so every
  `*.live.test.ts` file skips (BL-01 6536548556). A non-zero `skipped` count is expected; the check is
  that every skipped file is a live one. On a saved CI log (`gh run view <id> --log > ci.log`),
  `grep -a skipped ci.log | grep -a '\.test\.ts' | grep -av '\.live\.test\.ts'` prints nothing (each
  vitest file line carries its path and its `| n skipped` count). A live test
  is named `*.live.test.ts` and skips only on a missing credential.
- **msw timeout tests wait out the late response.** A delayed msw response whose request the client
  already aborted makes the next request on that server fail with `HttpNetworkError` if it starts
  before the delay ends (BL-01 6537331135). Serve the late answer with `LATE_RESPONSE_MS` and
  `await settleLateResponse()` (`apps/worker/test/actions-support.ts`) before the next call to that
  server or before the test returns.

## Design review
Every ticket labelled `frontend` passes the `ui-reviewer` agent (independent of the builder) against `docs/design/` before merge.

## Prerequisites rule
A ticket starts only when every `needs:` item passes `python3 scripts/check-prereqs.py --ticket <ID>`. A missing item holds that ticket and its dependants only; everything else proceeds.

## Hard rules
- Never read or print `.env`; presence checks only
- No feature is cut or deferred for time; time sets the pace, not the scope
- Gates are hard stops; features are never deferred to pass a gate
- Ticket IDs are permanent once issues exist
- The repo stays private until the owner says otherwise

## How a cold session resumes
1. Read `CLAUDE.md`, then run `/status`
2. `python3 scripts/check-prereqs.py` for owner items still missing
3. `python3 scripts/waves.py <current milestone>`, then `/start-milestone <n>` or `/start <ID>`

## How the backlog stays small
- Every ticket runs a best-effort backlog pass before merging (`/start` Phase 7b); it never blocks the merge
- Every passed gate spawns a post-gate sweep worker (`/gate` step 8): one PR; decisions go to the owner; it never holds the next milestone
