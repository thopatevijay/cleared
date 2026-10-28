---
description: Run a milestone-gate verification — proves a milestone is truly complete before the next starts
argument-hint: <gate-ticket-id>   e.g. /gate M1-GATE
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, SendMessage, AskUserQuestion
---

# /gate — verify a milestone is genuinely done

Gate: **$ARGUMENTS**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # this project's repo
```

Every `gh` call below uses `-R "$REPO"`. Derive it once; never hardcode an owner/name.

## Why gates are hard stops

The first build milestone makes one path work end to end; later ones build the scoring loop and
the differentiators on top of it. **Each milestone assumes the previous one actually works.** A gate
that is waved through turns the plan into a broken demo at the deadline, with no recovery time.

## Steps

1. Resolve the gate ticket and read it in full, including comments:
   ```bash
   cd "$(git rev-parse --show-toplevel)"
   python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['$ARGUMENTS'])"
   gh issue view <n> -R $REPO --comments
   ```

2. Confirm **every** ticket in the gate's `blocked_by` list is closed. List any that are not.
   An open blocker means the gate cannot pass — report and stop. Features are never closed as
   deferred to pass a gate: scope is set by the product, not the calendar.

3. Run the gate's Validation Gate block **from a clean state**, verbatim. Clean state means what the
   ticket says — usually `docker compose up` from scratch plus migrations plus seed. Do not reuse a
   warm environment; the point is to prove reproducibility.

4. Walk every Acceptance Criterion and record `PASS — <evidence>` or `FAIL — <why>`.
   Evidence is command output, a test name, a screenshot, or a queried row count.

5. Capture whatever the gate requires: screenshots to `.review/<GATE-ID>/` (gitignored; copy only
   README-worthy shots into `docs/screenshots/`), measured numbers, counts.

6. Post the result as a comment on the gate issue — the numbers table the ticket asks for, plus the
   AC results. This comment is what a future session reads to know the milestone genuinely closed.

7. If **PASS**: close the gate issue with `status:done`, then run step 8 (the post-gate backlog
   sweep) and report the next milestone's first `/start` command (or `/start-milestone <n>`).
   If **FAIL**: leave it open, label `status:blocked`, list exactly which ACs failed and what must
   happen. **Do not open next-milestone tickets.** Log the cause to `BL-01`. No sweep on a failed gate.

8. **Post-gate backlog sweep (PASS only; best effort; never part of the gate).**
   Complements `/start` Phase 7b at milestone scale, so `BL-01` keeps shrinking with every milestone
   instead of piling up for the end. The gate is already closed: nothing here can reopen it or hold
   the next milestone.

   a. **Spawn one worker** (Agent tool, `isolation: "worktree"`) with the brief below. **Do not wait
      on it.** Report the next milestone's command now; the next milestone may start in parallel.
      Record the sweep branch and worktree in `.prp/MILESTONE-<MS>.md` (Carry forward).

   > Run a **backlog sweep** for milestone `<MS>` (gate `<GATE-ID>` passed and is closed). Read
   > `.claude/commands/gate.md` step 8 and `/start` Phase 7b first; do not work from memory.
   >
   > 1. Branch `chore/backlog-sweep-<ms-lowercase>-$(date +%d-%m-%Y)` off `origin/main`.
   > 2. List the open `BL-01` entries (the `/start` Phase 0 step 5 query) and keep those that are
   >    `**Status:** open`, `deferred → <ticket>` where that ticket is now closed, or whose
   >    `**Owner ticket:**` is a ticket of `<MS>`.
   > 3. Work through them, best effort: fix as many as you can, each with a test or evidence, one
   >    commit per entry (`fix(<scope>): BL-01 <short> (sweep <MS>)`). Re-run
   >    `./scripts/landing-checks.sh` after each fix.
   > 4. **Stop working an entry at a blocker** and revert that attempt so the branch stays green.
   >    Blockers: a missing prerequisite or owner action; another open ticket's scope or AC; more
   >    than a small fix; it breaks a check. Then move to the next entry.
   > 5. An entry that needs an **owner decision**: do not decide it and do not wait. Add it to a
   >    *Decisions needed* list (entry, question, options, your recommendation) and move on.
   > 6. Update every entry you touched **in place** (`/start` Phase 7b step 4, `gh api -X PATCH
   >    repos/$REPO/issues/comments/<id>`): `fixed in #<pr> (sweep <MS>)`, `deferred → <ticket>
   >    (<blocker>)`, or `accepted limitation (<reason>)`.
   > 7. Push and open the PR (`gh pr create -R "$REPO" --base main --head <branch>`, body says
   >    `Relates to #<BL-01 number>`), with a **Sweep** table: entry → fixed / deferred (why) /
   >    needs decision / not tried. **Do not merge it.**
   > 8. Report the PR number, its checks status, the Sweep table and the *Decisions needed* list.
   >
   > - You hold **no exclusive resource** (see `.github/plan/resources.json`) unless granted here:
   >   `<none | list>`. Budget: `<none | e.g. LLM: $N>`; no budget means no budgeted spend at all.
   > - Never edit a file an in-flight ticket owns, or a hot file (`<list from CLAUDE.md>`), without
   >   asking the manager first; skip the entry if unsure.
   > - Never weaken a check, AC or threshold to close an entry.
   > - `gh` runs outside the Bash sandbox. Commits carry no Claude co-author or generated-with
   >   trailer. `.env` is off limits.
   > - Fixing nothing is a valid result: say so and report.

   b. **When it reports**, verify against GitHub as `/start-milestone` 3b does, then merge it with
      the `/start-milestone` 3c recipe **only on green checks** (never merge red; fix or drop the
      offending commit, or leave the PR open and say so). Remove its worktree after the merge.
   c. **Ask the owner** each *Decisions needed* item with AskUserQuestion (or put them on the owner
      list if they are away). Record each answer on its `BL-01` entry.
   d. Comment one line on the gate issue: `Backlog sweep: #<pr> merged, <n> fixed, <n> deferred,
      <n> need a decision` (or `Backlog sweep: nothing fixable`). Nothing fixed is fine: record it
      and move on.

## Do not

- Do not pass a gate on the strength of code that looks correct. Gates are empirical.
- Do not defer a *non-bonus* AC to "later" — later is the deadline.
- Do not skip the clean-state requirement. A demo that only works on your warm machine will fail on
  stage, which is precisely what the gates exist to prevent.
- Do not make the backlog sweep a gate requirement, hold the next milestone for it, or let it weaken
  a check.
