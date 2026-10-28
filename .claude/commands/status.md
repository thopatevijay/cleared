---
description: Reconstruct project state from GitHub — what is done, in flight, blocked, next
allowed-tools: Bash, Read, Grep
---

# /status — where the project actually stands

Assume **no prior context**. Rebuild the picture from GitHub and git alone, then report it.
This command is what makes a fresh session productive in under a minute.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # this project's repo
```

Every `gh` call below uses `-R "$REPO"`. Derive it once; never hardcode an owner/name.

## Gather

```bash
cd "$(git rev-parse --show-toplevel)"

echo "=== MILESTONES ==="
gh api repos/$REPO/milestones?state=all --jq \
  '.[]|"\(.title): \(.closed_issues)/\(.open_issues + .closed_issues) closed · due \(.due_on[0:10])"'

echo "=== IN FLIGHT ==="
gh issue list -R $REPO --label "status:in-progress" \
  --json number,title --jq '.[]|"#\(.number) \(.title)"'

echo "=== BLOCKED ==="
gh issue list -R $REPO --label "status:blocked" \
  --json number,title --jq '.[]|"#\(.number) \(.title)"'

echo "=== OPEN, BY MILESTONE ==="
gh issue list -R $REPO --state open --limit 60 \
  --json number,title,milestone,labels \
  --jq 'sort_by(.milestone.title, .number)[]|"\(.milestone.title // "—")  #\(.number)  \(.title)"'

echo "=== RECENTLY CLOSED ==="
gh issue list -R $REPO --state closed --limit 12 \
  --json number,title,closedAt --jq 'sort_by(.closedAt)|reverse[]|"#\(.number) \(.title)"'

echo "=== BACKLOG SIZE ==="
gh issue view $(python3 -c "import json;print(json.load(open('.github/plan/issue-map.json'))['BL-01'])") \
  -R $REPO --json comments --jq '.comments|length'

echo "=== GIT ==="
git branch --show-current; git status --short
git log --oneline -12
git branch -r --list 'origin/feat/*'      # abandoned WIP branches?

echo "=== LOCAL PRPs (interrupted work) ==="
ls -la .prp/ 2>/dev/null || echo "none"
```

## Report

Produce a short, decision-oriented summary:

1. **Milestone position** vs the calendar: compare each milestone's due date (GitHub) with what
   is closed, against the submission deadline in `PROJECT.md` §1. State ahead / on track / behind, and by how much.
2. **In flight** — anything with `status:in-progress`. If a PRP exists in `.prp/` for a ticket that
   is not in flight, that is interrupted work: say so and recommend resuming it.
3. **Blocked** — each one, with what would unblock it (read the blocked comment).
4. **Next up** — the lowest-numbered open ticket whose blockers are all closed. Give the exact
   command: `/start <TICKET-ID>`.
5. **Gate status** — is the current milestone's `*-GATE` ticket passable? Gates must close before the
   next milestone's tickets start.
6. **Owner list** — run `python3 scripts/check-prereqs.py` (if present) and list every MISSING item
   with its `how`, plus any action named in a `status:blocked` note.
6. **Risks** — open `blocker-risk` tickets, unanswered organiser questions (`M0-02`), and any
   abandoned `feat/*` remote branch.

Keep it to a screenful. End with the single recommended next command.
