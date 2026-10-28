---
title: "M5-03 · Devpost description + AI-tools section + screenshots"
milestone: "M5 · Submission"
labels: ["docs"]
blocked_by: ["M5-01"]
estimate: "2h"
resources: []
needs: []
---

## Context

The Devpost entry is the submission of record. It needs a text description, the AI tools named and how they're used, the hosted demo, the public repo, and the video (PROJECT.md §1 Artefacts; Stage One is pass/fail on these). Judges may judge from the text and images alone, so the Devpost text must match the README's claims exactly and stand on its own. Rubric: Presentation, Stage One.

## Scope

- **`docs/submission/devpost.md`**, with one section per Devpost field, ready to paste:
  - project name ("Cleared"); tagline (≤ 60 chars)
  - Inspiration (the seller pain with quotes); What it does (the three moments + approval gate); How we built it (stack, architecture, the PayPal APIs actually used, the same list as the README)
  - **AI tools used and how**: OpenAI models by pinned ID per workflow, guardrails, verbatim citations, eval method (synthetic gold sets, owner-labelled, second-model reviewed); the AI tools used to build it (Claude Code)
  - Challenges (sandbox realities: app-scoped webhooks, no Transaction Search scope, the labelled sandbox decision); Accomplishments (the measured numbers with *n*); What we learned; What's next (future vision)
  - Built with (tags); Try it out links (hosted URL, repo, video)
  - the honest-limits paragraph, and the outcome wording "the seller keeps the money (PayPal covered the case)"
- **Gallery images** in `docs/submission/gallery/`: 6–8 PNG/JPG at 3:2, each ≤ 5 MB, with captions. They show the hero dashboard, the proof pack with citations, the Hindi hold explanation, the dispute draft and approval, the labelled sandbox decision, the cash calendar, the architecture, and the eval results. All are captured from production with synthetic data
- **Consistency check** `pnpm devpost:check`: the PayPal API list and every number are identical to the README and `docs/evidence/*.json`; the forbidden phrases are absent; the links return 200 (hosted URL, video; the repo link is checked after it goes public, in M5-SUBMIT); the image sizes and ratios are right
- **Sponsor prizes:** state Bryntum use (if the licence decision allowed it) and Render hosting, factually

## Out of scope

- Entering the text into Devpost and submitting (M5-SUBMIT, owner)
- Changing README claims (M5-01)
- The video itself (M5-02)

## Acceptance Criteria

- [ ] `docs/submission/devpost.md` has every Devpost field listed in Scope (`pnpm devpost:check --fields` passes)
- [ ] `pnpm devpost:check` passes: API list and numbers identical to the README and reports, forbidden phrases absent, the hosted URL and video URL return 200
- [ ] 6–8 gallery images exist, each 3:2 (±1%) and ≤ 5 MB, each with a caption
- [ ] The tagline is ≤ 60 characters

## Deliverables

- `docs/submission/devpost.md`, `docs/submission/gallery/*`, `scripts/check-devpost.ts`

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm devpost:check --fields
pnpm devpost:check
n=$(ls docs/submission/gallery/*.{png,jpg} 2>/dev/null | wc -l); [ "$n" -ge 6 ] && [ "$n" -le 8 ]
find docs/submission/gallery -type f -size +5M | (! grep .)
```

## Handoff

- **M5-SUBMIT**: the owner pastes each section into Devpost and uploads the gallery
- **M5-CLEANUP** keeps `docs/submission/` tracked
