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
