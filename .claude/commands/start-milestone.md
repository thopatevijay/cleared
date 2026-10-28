---
description: Run a whole milestone — this session is the manager, one subagent per ticket, parallel where the dependency graph allows
argument-hint: <milestone>   e.g. /start-milestone 1  or  /start-milestone M1
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, SendMessage, TaskStop, PushNotification
---

# /start-milestone — a whole milestone, one command

Milestone: **$ARGUMENTS** (bare digits work: `1` → `M1`)

**You are the manager. You never implement a ticket.** You plan waves, spawn one worker subagent per
ticket, keep shared resources from colliding, merge in order, gate each batch, post handoffs, and
keep going until every spawnable ticket has landed. The owner runs one command and walks away; they
come back to finished work plus **one list** of anything only they can do.

## How the manager/worker split works

- Workers are **Agent-tool subagents with `isolation: "worktree"`**: own context window, this
  session's permission mode, automatic report on completion.
- **Durability lives in git.** A worker's progress is its `feat/` branch and `.prp/<TICKET>.md`;
  re-spawning a ticket resumes its branch (`/start` Phase 0). Record every in-flight branch and
  worktree in the run log **before** waiting.
- **Pull, never stream.** A successful worker's PR body and handoff are the interface. Investigate a
  worker's branch only when it reports blocked or a batch gate goes red.
- The manager edits no source file, except resolving an additive hot-file conflict at merge (§3c).

## Rules that make parallel work safe

1. **Never overlap waves.** Wave N+1 reads wave N's handoff comments.
2. **A worktree isolates files, not shared resources.** Limits live in `.github/plan/resources.json`
   and are applied by `scripts/waves.py`: at most `max_workers` per batch, at most one ticket per
   **exclusive** resource per batch, and a spend budget per worker for **budgeted** resources. Each
   worker runs its local stack with its own `PORT_OFFSET`.
3. **The GitHub issue is the specification.** Every worker runs the full `/start` contract.
4. **Change the evidence, never the standard.** A worker that cannot pass honestly goes to
   Phase 8-BLOCKED; it never lowers a threshold, widens a timeout or weakens a check.
5. **A blocked ticket stops its dependants, not the milestone.** Keep landing everything that does
   not depend on it. Stop the whole run only for the conditions in "Stop immediately".

## Step 0 — Resume or start

```bash
cat .prp/MILESTONE-$ARGUMENTS.md 2>/dev/null || echo "no run log: fresh start"
```

A run log means resume: read it, then re-plan. GitHub says what landed; the log says why, what is in
flight, what was decided, and what the owner still owes.

## Step 1 — Plan, prerequisites, pre-flight

```bash
cd "$(git rev-parse --show-toplevel)"
git checkout main && git pull --ff-only origin main && git fetch --prune origin
python3 scripts/check-prereqs.py          # the whole inventory, for the owner list
python3 scripts/waves.py $ARGUMENTS
```

Both call `gh` or cloud CLIs: run with `dangerouslyDisableSandbox: true`.

| Planner says | Meaning | Do |
|---|---|---|
| batch listed | spawnable now | spawn (Step 3) |
| `HELD … prerequisite P-xx missing` | the owner must provide something | do **not** spawn it or its dependants; add the item to the owner list; spawn everything else |
| `HELD … depends on X` | upstream is held or blocked | skip; re-plan after X lands |
| `HELD … .prp exists` / `feat/ branch exists` | interrupted work | re-spawn that ticket: `/start` resumes its branch |
| `HELD … status:blocked` | stopped for a stated reason | read its blocked note; add the unblock action to the owner list |
| `⏳ owned by another session` | someone is on it | skip; wait before its dependants (Step 4) |
| `✋ pre-flight` (dirty tree, not on main, docker down) | the run itself is unsafe | **stop and report** |
| `Spawnable now: 0` | nothing can run | report the owner list and stop |

**If anything is held for the owner, notify them now** (PushNotification if available, one message
listing the actions), then carry on with the spawnable tickets. Do not wait for a reply.

Another session working in this working tree (current branch is an in-flight ticket) is a hard stop.

## Step 2 — Read blockers' handoffs as the manager

```bash
gh issue view <blocker> --json comments --jq '.comments[] | select(.body | test("Handoff")) | .body'
```

Look for facts that change the **schedule**: measured durations, quota or spend, contention between
tickets with no dependency edge.

## Step 3 — Run each wave, batch by batch

### 3a. Spawn

One batch at a time. **Send every worker of a batch in one message** so they run concurrently.
Implementation workers use the default model. A ticket that is mostly supervising (watching a live
run, a deploy or a long pipeline) gets `model: "sonnet"` or `"haiku"`; pure waiting needs no worker
at all, only a background `until` loop.
Each worker gets exactly this prompt (fill the `<>`):

> Run the ticket `<TICKET-ID>` by following `.claude/commands/start.md` exactly (read the file
> first; do not work from memory). **Phases 0–6b apply as written**: orient, blocker and
> prerequisite check, branch, PRP, start note, implement, the full Phase 6 verification gate and,
> for `frontend` tickets, the Phase 6b `ui-reviewer` design review.
>
> **Phase 7c is replaced: do not merge, do not close the issue, do not set `status:done`.** Stop
> after commit → `git push -u origin <branch>` → `gh pr create`. The PR body must carry everything
> Phase 7c requires, **including the full handoff section**, but **not** `Closes #<n>` (the manager
> closes the issue after posting the handoff; use `Relates to #<n>`). Then run **Phase 7b, the
> backlog pass, exactly as written**. It's best effort: fix what you can on your branch, stop at the
> first blocker, revert that attempt, and update the BL-01 entries you touched. Never let it delay
> your report. Report the PR number, its checks status, and the Backlog pass table.
>
> - Local stack: `PORT_OFFSET=<n>`. Never use another worker's ports.
> - Exclusive resources you hold: `<list or none>`. Resources you do not hold must not be used
>   (no deploys / applies / quota-bound calls); use recorded responses instead.
> - Budget: `<per budgeted resource>`; report actual spend.
> - `gh` runs outside the Bash sandbox. `.env` is off limits absolutely (CLAUDE.md STRICT RULE).
> - Read your own issue's comments before writing code.
> - Hot files (`<list from CLAUDE.md>`): keep edits minimal and list exactly what you changed.
> - A missing credential or owner action, at any point: follow `/start` Phase 1's mid-ticket rule
>   and go to Phase 8-BLOCKED **immediately**. Never wait for a value.
> - Phase 6 runs `./scripts/landing-checks.sh --fast` plus your ticket's Validation Gate verbatim.
>   After a rebase or the backlog pass, re-run `--fast` once. The manager runs the full level.
> - Prove each AC with the recorded fixtures from the M0 integration spikes unless the AC itself
>   requires a live run.
> - Log spend from the API responses at call time (tokens × price, units used). **Never wait or poll
>   for a dashboard, balance or any value that settles later**; the manager reconciles at batch close.
> - Never sit polling a pipeline or long run in conversation: use one background `until` loop (or
>   Monitor) that notifies on completion.
> - Keep context small: read handoffs and the files you change; send broad searches to an Explore
>   subagent.

### 3b. Wait, then verify against GitHub

Workers report on their own; never poll in-conversation and never invent a result. For each:

```bash
gh pr list --head <branch> --json number,title
gh issue view <n> --json labels --jq '[.labels[].name]'
gh pr checks <pr>
```

| Signal | Do |
|---|---|
| PR exists, checks green, issue `status:in-progress` | merge (3c) |
| PR exists and green, backlog pass incomplete or empty | **merge anyway** (3c). The backlog pass is best effort and never holds a merge |
| PR exists, checks failing | treat as blocked: read the failing run (`gh run view <id> --log-failed`); the worker's gate and CI disagree |
| issue `status:blocked` | read the blocked note; add any owner action to the owner list; **hold its dependants, continue the rest** |
| "success" but no PR | treat as blocked |

### 3c. Merge in planner order

Watch every PR of the batch at once, in one background command (`run_in_background`), not one
after another:

```bash
for pr in <pr numbers>; do gh pr checks "$pr" --watch >/dev/null 2>&1 & done; wait
```

Then merge in planner order:

```bash
gh pr checks <pr>                        # never merge red
gh pr merge <pr> --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

Additive hot-file conflict → resolve it yourself from the worker's report. Keep the worktree until
the ticket is closed (3e).

### 3d. Gate the batch once

```bash
./scripts/landing-checks.sh     # the ONE chain shared with /start Phase 6; full level, never --fast
```

Workers ran `--fast`, so this is where a cross-workspace break is caught.

Plus whatever the project's CLAUDE.md lists as batch-level checks (e.g. `make up && make test &&
make down`, an infrastructure plan showing no drift after a deploy ticket).

Red after a merge: fix on `main` or revert the offending merge and re-open its ticket
`status:blocked` with the real error. **Never start the next batch on a red `main`.**

### 3e. Close out

```bash
gh issue comment <n> --body "<handoff, from the PR body>"
gh issue edit <n> --remove-label "status:in-progress" --add-label "status:done"
gh issue close <n> --reason completed
git worktree remove <path> && git worktree prune     # only now
```

A finding that breaks a later ticket gets a comment **on that ticket** as well as on BL-01.

### 3f. Update the run log after every batch, unconditionally

`.prp/MILESTONE-<MS>.md` (gitignored):

```markdown
# Milestone <MS> run log · updated <timestamp>
## Waves
- [x] wave 0 batch 0: M1-00 (#n) PR #m merged
- [ ] wave 1 batch 0: M1-01, M1-06 IN FLIGHT (branch, worktree, PORT_OFFSET per ticket)
## Held / blocked (and why)
## Owner list (actions only the owner can take, with the exact how)
## Decisions
## Spend
## Carry forward
```

Spend: add the workers' logged figures, then reconcile once against the provider's settled numbers
(dashboards that lag are read here, never by a worker).

### 3g. Re-plan before the next batch

```bash
python3 scripts/check-prereqs.py >/dev/null; python3 scripts/waves.py $ARGUMENTS
```

The owner may have provided something since the last batch: a held ticket can become spawnable.

## Step 4 — Waiting on a ticket another session owns

Wait with a background shell loop (one notification, no context cost), capped at ~30 minutes:

```bash
until gh issue view <n> --json state --jq .state | grep -q CLOSED; do sleep 60; done
```

Still open → continue with everything else, then report. Never take over another session's ticket.

## Step 4b — Manager context running low

Only at a batch boundary: finish merging, gating and closing out; update the run log; tell the
owner: *"Manager context is running low. Run `/start-milestone <MS>` in a fresh session; it resumes
from the run log."* Prefer that over continuing through compaction.

## Step 5 — Finish

When no spawnable ticket remains, report:
- tickets landed (with PRs), tickets held or blocked (with the reason each)
- **the owner list**, one block, in dependency order, each line with its exact `how`
- spend, and the next command: `/gate <GATE-ID>` if everything landed, otherwise "complete the owner
  list, then `/start-milestone <MS>` again; it resumes and runs only what is left"

Send the same summary as a push notification if available. **Do not run the gate yourself**; it
runs from a clean clone and the owner decides when.

**After the gate passes**, `/gate` step 8 spawns one **post-gate backlog sweep** worker (its own
worktree, brief in `gate.md`) that fixes what it can from `BL-01`, best effort, and opens one
`chore/backlog-sweep-<ms>-<date>` PR. It is never a gate requirement and never holds the next
milestone: `/start-milestone <next>` may run while it works. Whoever ran the gate merges the sweep PR
on green and asks the owner its *Decisions needed* items. If this session is still running when the
sweep is in flight, treat it like any worker: it holds no exclusive resource and gets no budget
unless you grant one, and it must not edit files of a ticket you have in flight or a CLAUDE.md hot
file without asking you first.

## Stop immediately if

- `main` is red after a merge and you cannot fix or revert it
- another session is using this working tree
- spend for the milestone exceeds what the owner approved in `docs/budget.md`
- a security problem: a leaked secret, an exposed bucket, a credential in a commit

## Do not

- implement a ticket yourself, or paraphrase `/start` to a worker (point it at the file)
- overlap waves, exceed `max_workers`, or put two tickets on one exclusive resource
- let a worker merge its own PR, merge on red or pending checks, or remove a worktree before its
  issue is closed
- wait on the owner while other tickets could run
- relax an AC, a gate or a threshold because a worker is slow
- hold the next milestone for the post-gate backlog sweep, or grant it an exclusive resource or
  budget it did not ask for
