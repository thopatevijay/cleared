---
description: Run one ticket end to end — branch, PRP, implement, verify, commit, PR, backlog pass, merge, close
argument-hint: <ticket-id | issue-number>   e.g. /start M2-04  or  /start 27
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill
---

# /start — execute one ticket, fully

Target: **$ARGUMENTS**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # this project's repo
```

Every `gh` call below uses `-R "$REPO"`. Derive it once; never hardcode an owner/name.

You are running a single ticket of the project to completion. This command is
**session-independent**: assume you have *no* prior conversation context. Everything you need is in
GitHub and in this repo. Reconstruct it. Never guess, never rely on remembered state, and never
invent a ticket's contents.


## Ground rules — non-negotiable

1. **The GitHub issue is the specification.** Do not add scope, do not remove scope, do not
   "improve" the ticket. If the ticket is wrong, say so and stop — do not silently deviate.
2. **Every Acceptance Criterion must actually be met**, verified by running something, not by
   reading the code and feeling confident.
3. **Every command in the ticket's Validation Gate must be run verbatim and must pass.** If a
   command cannot run, that is a blocker, not a formality to skip.
4. **Never fake a pass.** If an AC cannot be met, go to Phase 8-BLOCKED.
5. Anything you discover that is out of this ticket's scope goes to the **backlog issue** (`BL-01`).
   Do not fix it here.
6. Commits: conventional messages, **no Claude co-author trailer, no "generated with" line**.
   Prefer several small commits over one large one.
7. Never commit `.env`, `.dev-refs.md`, `.prp/`, credentials, or any secret.
8. `gh` runs **outside the Bash sandbox** (`dangerouslyDisableSandbox: true`): the sandbox's TLS
   proxy breaks Go's certificate verification.

---

## Phase 0 — Orient (always, no exceptions)

```bash
cd "$(git rev-parse --show-toplevel)"
cat .github/plan/issue-map.json
git status --short && git branch --show-current
gh issue list -R $REPO --state open --limit 60 \
  --json number,title,labels --jq '.[]|"\(.number)\t\(.title)"'
```

Resolve **$ARGUMENTS** to a ticket id and an issue number using `.github/plan/issue-map.json`
(it maps `M2-04 -> 27`). If the argument is a number, reverse-map it. If it resolves to nothing,
stop and tell the user.

Then read, in this order:
1. `gh issue view <n> -R $REPO --comments` — **the specification, plus every handoff
   note left by previous tickets**
2. `.github/plan/<TICKET-ID>-*.md` — the versioned source of the ticket
3. `PROJECT.md` — architecture, locked decisions, constraints
4. The `Blocked by:` comment on the issue
5. **Open `BL-01` entries this ticket owns or touches**: entries whose `Owner ticket` is this ticket, and
   any open entry (`**Status:** open`) about files in this ticket's deliverables. They go into the
   PRP's *Backlog pass* list and are worked in Phase 7b:
   ```bash
   BL=$(python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])")
   gh api "repos/$REPO/issues/$BL/comments" --paginate \
     --jq '.[] | select(.body|test("\\*\\*Status:\\*\\* open")) | "\(.id)\t\(.body|split("\n")[0])"'
   ```

## Phase 1 — Blocker and prerequisite check

**Blockers.** For every blocker issue: confirm it is **closed**. If any is open:

> Stop. Report which blockers are open. Ask whether to proceed anyway (the user may have a reason)
> or to switch to a blocker instead. Do not start.

**Prerequisites.** If `.github/plan/prereqs.json` exists (ticket M0-00), check this ticket's `needs:`:

```bash
python3 scripts/check-prereqs.py --ticket <TICKET-ID>
```

Anything `MISSING` → **stop now, before branching.** Report each missing item with its `who` and
`how` lines verbatim so the owner can act in one go. Never start a ticket hoping the key appears
later: the point of this check is that a ticket fails in its first minute, not its sixth hour.

**A prerequisite you discover mid-ticket** (an API key, scope, console step or paid plan that is not
in `prereqs.json`): add it to `prereqs.json` with a `verify` command, add its id to this ticket's
`needs:`, commit that as WIP, and go to **Phase 8-BLOCKED immediately** with the owner action in the
blocked note. Never wait at a prompt for a value, and never work around a missing credential with a
mock in the product path.

## Phase 2 — Branch

```bash
git checkout main && git pull --ff-only origin main 2>/dev/null || git checkout main
git checkout -b feat/<ticket-id-lowercase>-<short-slug>-$(date +%d-%m-%Y)
```

If the branch already exists, check it out and continue from where it left off (a previous session
may have been interrupted — read its commits first with `git log --oneline main..HEAD`).

## Phase 3 — Write the PRP

Write `.prp/<TICKET-ID>.md` (gitignored — local working memory, not a deliverable):

```markdown
# PRP - <TICKET-ID> - <title>
Issue: #<n> · Branch: <branch> · Started: <ISO timestamp>

## Ticket summary
<2-4 lines, in your own words>

## Inherited context
- **Handoffs received:** <from blocker issue comments — quote them>
- **Open blockers:** <none | list>
- **Assumptions I am making:** <explicit, so a future session can challenge them>

## Acceptance Criteria -> plan
| # | AC (verbatim) | How I will satisfy it | How I will PROVE it |
|---|---|---|---|

## Deliverables -> files
| Deliverable | Path |
|---|---|

## Validation Gate commands
<copied verbatim from the ticket>

## Execution steps
1. ...

## Findings for BL-01
<append as you go: bug / gap / pitfall / constraint; log each with /backlog when found>

## Backlog pass (Phase 7b)
<open BL-01 entries from Phase 0 step 5 + everything this ticket logged: fix / defer / accept>

## Handoff to produce on completion
<what downstream tickets need to know — numbers, shapes, contracts>
```

**The AC table must be complete before you write any code.** If you cannot state how you will
*prove* an AC, you do not yet understand it — re-read the ticket.

## Phase 4 — Post the start note

```bash
gh issue edit <n> -R $REPO --add-label "status:in-progress"
gh issue comment <n> -R $REPO --body "<start note>"
```

Start note contains: branch name, timestamp, inherited handoffs (or "none"), assumptions, and a
3-6 bullet plan.

## Phase 5 — Implement

Follow the PRP's execution steps. While working:
- Match the surrounding code's conventions. TypeScript strict, no `@ts-ignore`, no `any`.
- Python: type hints, no bare `except`.
- Commit at each meaningful checkpoint: `git commit -m "feat(<scope>): <what> (<TICKET-ID>)"`
- Every discovery outside scope -> append to the PRP's Findings section. Do not chase it.
- If you find the ticket itself is wrong or impossible -> Phase 8-BLOCKED. Do not improvise a
  different ticket.

## Phase 6 — Verification gate (hard stop)

Re-read the issue body. Then, **mechanically**:

1. **Acceptance Criteria** — for each one, state: `AC <n>: PASS — <the evidence>` or
   `AC <n>: FAIL — <why>`. Evidence is command output, a test name, or a file that exists.
   "Looks right" is not evidence.
2. **Deliverables** — confirm each listed path exists and is non-empty.
3. **Validation Gate** — run every command from the ticket verbatim. Paste the real output.
4. **Repo-wide checks** (always, regardless of ticket):
```bash
./scripts/landing-checks.sh     # the ONE chain shared with /start-milestone § 3d; edit the script, not this line
```
   Run standalone, `/start` uses the full level above. As a `/start-milestone` worker, use
   `./scripts/landing-checks.sh --fast` (changed workspaces only); the manager runs the full level
   once per batch and CI runs it on every PR. After a rebase, re-run the same level you ran here.
   Plus, in this context only:
   ```bash
   <the project's per-service checks from CLAUDE.md, e.g. Python lint + tests for a touched service>
   git status --short                                           # nothing unexpected staged
   ```

## Phase 6b — Design review (tickets labelled `frontend` only)

The implementing session never reviews its own UI. Before landing:

1. Capture screenshots of every screen the ticket touched with Playwright: widths **375 / 768 /
   1440**, **light and dark**, plus loading / empty / error states where the ticket defines them.
   Save to `.review/<TICKET-ID>/` (gitignored: review evidence stays local). Copy only a shot the
   README or a doc embeds into `docs/screenshots/` (tracked).
2. Run axe on the same pages; save the JSON next to the screenshots.
3. Spawn the **`ui-reviewer`** agent (Agent tool, `subagent_type: "ui-reviewer"`) with: the ticket id,
   the screen spec path in `docs/design/screens/`, the screenshot directory, and the axe results.
   Nothing else; it must not see your reasoning or the diff.
4. Its verdict is `PASS` or `CHANGES REQUIRED` with numbered issues marked **blocking** or
   **polish**. Fix every **blocking** issue, re-capture, and re-run the reviewer (max 3 rounds; still
   blocked → Phase 8-BLOCKED). **Polish** items go to `/backlog` unless trivial.
5. Put the final verdict and the screenshot paths in the PR body.

**If any AC, gate command or blocking design issue fails: do not proceed to Phase 7.** Either fix it,
or go to Phase 8-BLOCKED. There is no partial pass.

## Phase 7 — Open the PR (do not merge yet)

```bash
git add -A && git status --short          # review before committing
git commit -m "feat(<scope>): <summary> (<TICKET-ID>)"
git push -u origin <branch>

gh pr create -R $REPO --base main --head <branch> \
  --title "<TICKET-ID> · <title>" --body "<pr body>"
```

Every finding from this ticket must already be on `BL-01` (via `/backlog`) **before** the PR opens.
The PR stays open through Phase 7b (best effort, never blocking).

## Phase 7b — Backlog pass (best effort; never blocks the merge)

Backlog entries aren't left for the end of the build. With the PR open and its gate green, try to
fix as many open entries as you can from the PRP's *Backlog pass* list: what this ticket logged, plus
open entries it owns or touches (Phase 0 step 5). **It's optional and best effort.** Stop at the first
blocker, then merge and move on. A backlog entry never holds up a ticket.

Work through the entries in order:
1. **Try the fix** on this branch, with a test or evidence. Commit it separately (`fix(<scope>): BL-01 <short> (<TICKET-ID>)`).
2. **Stop the pass at the first blocker**, then go straight to step 4. A blocker is any of:
   - it needs a missing prerequisite or an owner action
   - it belongs to another open ticket's scope or AC
   - it's turning into more than a small fix
   - it breaks the gate

   Revert that attempt (`git revert`, or drop the uncommitted work), so the branch is back to green.
3. **Leave an entry alone** if it was never tried. It stays `**Status:** open`.
4. **Update every entry you touched, in place.** Edit the BL-01 comment; never add a duplicate. Set its `**Status:**` line:
   - `fixed in #<pr> (<TICKET-ID>)`
   - `deferred → <TICKET-ID> (<blocker>)`. Post a `blocker` comment on that ticket if it breaks it.
   - `accepted limitation (<reason>)`, kept for the submission's limitations section
   ```bash
   gh api -X PATCH "repos/$REPO/issues/comments/<comment id>" -F "body=@$TMPDIR/bl-note.md"
   ```
5. If anything was fixed, re-run `./scripts/landing-checks.sh` (at the level Phase 6 used) and the Validation Gate (Phase 6) verbatim, once after all fixes, not after each. If either fails, revert the backlog fix (never the ticket's own work) and mark it deferred.
6. Push, and add a **Backlog pass** table to the PR body (`gh pr edit <pr> -R $REPO --body-file …`): entry → fixed / deferred (why) / not tried.

Never weaken an AC or a check to close an entry. The ticket's own AC always come first.

## Phase 7c — Merge and close

```bash
gh pr checks <pr> -R $REPO --watch        # CI must be green; never merge red
gh pr merge <pr> -R $REPO --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

A failed check is a failed gate: fix it on the branch and push again. A repo with no CI configured
has nothing to wait for; Phase 6 is then the only gate.

PR body must contain: `Closes #<n>`, what changed, the AC checklist with evidence per item, the real
validation-gate output, the handoff for downstream tickets, and the **Backlog pass** table (every
BL-01 entry touched: fixed / deferred / accepted).

Then close out the issue (the merge may already have closed it via `Closes #<n>`):

```bash
gh issue comment <n> -R $REPO --body "<done note>"
gh issue edit <n> -R $REPO \
  --remove-label "status:in-progress" --add-label "status:done"
gh issue view <n> -R $REPO --json state --jq .state | grep -q CLOSED \
  || gh issue close <n> -R $REPO --reason completed
```

The **done note** is the durable handoff record. It must contain:
- one line per AC with its evidence
- deliverable paths
- gate result
- a `### Handoff -> <downstream ticket ids>` section with the concrete numbers, type shapes and
  endpoint contracts later tickets depend on

**This comment is the handoff mechanism.** A future session with zero context reads it. Be specific:
real measured values, real type shapes, real endpoint contracts — never "see the code".

Delete `.prp/<TICKET-ID>.md` only after the handoff comment is posted — the comment is the durable
record, the PRP is scratch.

## Phase 8-BLOCKED — when a ticket cannot complete

Never leave a ticket silently half-done. A future session must be able to pick it up cold.

```bash
git add -A && git commit -m "wip(<scope>): <what got done> (<TICKET-ID>)" && git push -u origin <branch>
gh issue edit <n> -R $REPO \
  --remove-label "status:in-progress" --add-label "status:blocked"
gh issue comment <n> -R $REPO --body "<blocked note>"
```

Blocked note must contain: what is done (with commits), what is not (the failing ACs verbatim), why
(root cause with the actual error output), what was tried, what would unblock it (specific — a
decision, a helpdesk answer, hardware, an upstream ticket), and the exact next step for a session
with no context.

Then report to the user: what is blocked, why, and the options. Log it to `BL-01`.

## Report back to the user

Close with a short summary: ticket, what shipped, AC pass count, gate result, PR link, handoff
posted, findings logged, and which `/start` to run next (per milestone order and blockers).
