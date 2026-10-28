---
title: "BL-01 · Backlog"
milestone: "M0 · Recon & Bootstrap"
labels: ["meta"]
blocked_by: []
estimate: "0h"
resources: []
needs: []
---

## Context

The single backlog issue for the whole build. During a short build every discovered problem is a
fork: fix it now and lose the ticket, or forget it and lose the finding. Logging it here is the third
option. A limitation found and stated is a strength (it goes into the README's "What this does not
do" and the future vision); the same limitation found by a judge is a hole. This issue never closes
before submission.

Entries are added with `/backlog <what you found>` (`.claude/commands/backlog.md`), fixed ticket by
ticket in `/start` Phase 7b (backlog pass), and swept after every passed gate (`/gate` step 8).
What remains at submission is triaged by M5-01 (README "What this does not do", future vision) and
M5-03 (Devpost text). (`backlog.md` names `M4-08` for that triage; Cleared has no M4-08, so M5-01 owns it.)

## Scope

**One comment per entry**, posted on this issue, in exactly this format:

```markdown
### <YYYY-MM-DD HH:MM> · found in <TICKET-ID> · <type>
**What:**        <one line>
**Impact:**      <what breaks or is at risk>
**Workaround:**  <what we did instead, or "none — deferred">
**Action:**      <fix now | fix before submission | accept as limitation | document in HLD>
**Owner ticket:** <ticket id whose scope it belongs to, or "this ticket">
**Status:** open
```

- `<type>` is exactly one of: `bug` · `gap` · `pitfall` · `constraint` · `assumption-wrong` · `perf` · `security` · `data-quality`
- `<TICKET-ID>` comes from the current branch (`git branch --show-current`)
- Triage rule: blocks the current ticket's AC → fix now **and** log; breaks a later ticket → log
  **and** post a `blocker` comment on that ticket; neither → log and defer
- If the finding invalidates `PROJECT.md`, correct `PROJECT.md` in the same commit as the current ticket's work

**`**Owner ticket:**`** names the ticket whose scope the fix belongs to. `/start` Phase 0 picks up
entries owned by the ticket being started; the post-gate sweep picks up entries owned by the
milestone just gated. Re-point it in place if ownership moves.

**`**Status:**`** is edited **in place** (never a duplicate comment, never deleted) by the backlog
pass and the post-gate sweep, with
`gh api -X PATCH repos/$REPO/issues/comments/<id> -f body=...`. Allowed values:
- `open`
- `fixed in #<pr>`
- `deferred → <ticket> (<blocker>)`
- `accepted limitation (<reason>)`

Owner decisions asked for by a sweep are recorded on the entry itself.

## Out of scope

- Vague notes ("perf could be better"): investigate until triageable, or drop
- Fixing an entry mid-implementation unless it blocks the current AC (do it in Phase 7b)
- Feature cuts: no feature is deferred for time; scope is set by the product

## Acceptance Criteria

- [ ] Every entry on this issue matches the format above (seven lines, a valid `<type>`, an `**Owner ticket:**` and a `**Status:**` line)
- [ ] No entry is deleted; status changes are in-place edits
- [ ] At M5-01, every remaining `open` entry is fixed, or `accepted limitation` and listed in the README

## Deliverables

- Comments on this issue (the GitHub issue mapped to `BL-01` in `.github/plan/issue-map.json`)

## Validation Gate

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BL=$(python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])")
gh api "repos/$REPO/issues/$BL/comments" --paginate -q '.[].body' > "$TMPDIR/bl01.txt"
grep -c '^### .* · found in .* · ' "$TMPDIR/bl01.txt"                       # entries
grep -c '^\*\*Owner ticket:\*\*' "$TMPDIR/bl01.txt"                          # equals entries
grep -E '^\*\*Status:\*\*' "$TMPDIR/bl01.txt" | grep -vcE '^\*\*Status:\*\* (open|fixed in #[0-9]+|deferred → [A-Z0-9-]+ \(.+\)|accepted limitation \(.+\))$'   # expect 0
```

## Handoff

- **Every ticket (`/start` Phase 0 / 7b):** reads entries it owns, updates their `**Status:**` in place
- **Every gate (`/gate` step 8):** the sweep worker fixes or defers entries owned by the milestone
- **M5-01 / M5-03:** turn accepted limitations into the README's "What this does not do" and the future vision
