---
title: "M5-SUBMIT · Submit (owner; repo public with OK)"
milestone: "M5 · Submission"
labels: ["owner", "meta"]
blocked_by: ["M5-GATE"]
estimate: "1h"
resources: []
needs: []
---

## Context

Submission closes **Thu 2026-11-12 12:00 PT = 20:00 UTC = Fri 2026-11-13 01:30 IST**. The internal target is **2026-11-12 18:00 IST (12:30 UTC)**, which leaves 7.5 h of buffer. The repo must be **public** with an **MIT licence visible in About**, or the entry is disqualified. Making it public is an owner-only action (CLAUDE.md "Never"). Every required artefact must be in Devpost: text, functional hosted demo, AI tools, repo, YouTube video < 3 min.

## Scope

1. **Owner's go-ahead:** the owner writes "OK to make public" on this issue. Nothing below starts before that comment
2. **Make public** (gh runs outside the sandbox): `gh repo edit thopatevijay/cleared --visibility public --accept-visibility-change-consequences`
3. **Set About:** description (the tagline), website (the hosted demo URL), topics (`paypal`, `ai-agent`, `hackathon`, `nextjs`, `openai`). Confirm the licence shows as MIT
4. **Verify logged out:** the repo page and README load without auth; the hosted URL and the video play logged out
5. **Tag** `v1.0.0-submission` on the submitted commit (a tag, not a history rewrite), so judges see exactly what was submitted
6. **Devpost (owner):** paste every field from `docs/submission/devpost.md`:
   - name, tagline, story sections, built with
   - the AI tools section
   - try-it-out links (hosted URL, repo URL)
   - the YouTube URL
   - the gallery images with captions
   - the eligibility and terms questions answered by the owner
   - sponsor-prize selections as eligible (Bryntum only if the licence decision allowed it)
7. **Submit before 2026-11-12 18:00 IST.** Then view the submission page logged out and save a screenshot to `.review/` (private). Confirm Devpost's submission email
8. **After submitting:** start the judging change freeze per `docs/operations/judging-runbook.md`. Edits are allowed only until the deadline, and only for errors

## Out of scope

- Any product, README or video change (each reopens its ticket; resubmitting an edit is allowed until the deadline)
- Judging operations Dec 1–15 (the runbook from M4-07)

## Acceptance Criteria

- [ ] The owner's "OK to make public" comment exists on this issue, timestamped before the visibility change
- [ ] `gh api repos/thopatevijay/cleared --jq '.visibility, .license.spdx_id, .homepage'` prints `public`, `MIT` and the hosted URL
- [ ] An unauthenticated `curl -sI https://github.com/thopatevijay/cleared` returns 200
- [ ] `git ls-remote --tags origin v1.0.0-submission` resolves to the M5-GATE commit
- [ ] The Devpost submission is marked submitted, before 2026-11-12 12:30 UTC. The owner posts the Devpost URL and the time on the issue
- [ ] The Devpost project page loads logged out (`curl -sf <devpost URL>`), and the hosted URL, repo and video links on it all return 200

## Deliverables

- A public repo with About set; the tag `v1.0.0-submission`; the submitted Devpost entry (URL on the issue)

## Validation Gate

```bash
set -euo pipefail
: "${PROD_URL:?hosted URL}" "${DEVPOST_URL:?Devpost project URL}" "${VIDEO_URL:?YouTube URL}"
gh api repos/thopatevijay/cleared --jq '.visibility, .license.spdx_id, .homepage' | tee "$TMPDIR/repo.txt"
grep -x public "$TMPDIR/repo.txt" && grep -x MIT "$TMPDIR/repo.txt"
env -u GH_TOKEN curl -sfI https://github.com/thopatevijay/cleared >/dev/null
git ls-remote --tags origin v1.0.0-submission | grep -q .
curl -sf "$DEVPOST_URL" -o /dev/null && curl -sf "$PROD_URL/healthz"
curl -sf "https://www.youtube.com/oembed?url=${VIDEO_URL}&format=json" -o /dev/null
[ "$(date -u +%s)" -lt "$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' 2026-11-12T20:00:00Z +%s)" ] || echo "WARNING: past the hard deadline"
```

## Handoff

- The judging runbook (M4-07) takes over from 2026-12-01; demo workspaces are purged on 2026-12-22
- BL-01 collects post-submission items, which are not acted on until judging ends, unless they are runbook fixes
