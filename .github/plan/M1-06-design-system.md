---
title: "M1-06 · Design system + hero-screen specs (ux-designer)"
milestone: "M1 · Walking Skeleton"
labels: [docs, critical]
blocked_by: [M0-GATE]
estimate: "4h"
resources: []
needs: []
---

## Context
**Design** is a judging criterion ("one coherent journey: mobile-first, multilingual, accessible, honest limits"). Every `frontend` ticket from M1-07 on is built to `docs/design/` and reviewed by `ui-reviewer` against it. Without the specs first, there's nothing to review against. The `ux-designer` agent (`.claude/agents/ux-designer.md`) produces this work. The builder of later screens never approves them.

## Scope
Run the `ux-designer` agent. It loads the `frontend-design` skill first (or says in the README that the skill isn't installed), reads `PROJECT.md`, `docs/architecture.md` and RESEARCH §9 (the hero wireframe), and produces:
- **`docs/design/README.md`:**
  - users: freelance and service sellers in India, Kenya, Nigeria, Indonesia and the Philippines, on mobile, often on slow networks, in EN/HI; and the **hackathon judge**, who has 3 minutes and needs a self-explaining first screen
  - direction, the nine principles from the agent file, and voice and tone
  - copy rules from the claims discipline: "seller keeps the money (PayPal covered the case)", never "won"; "estimated" on every release date with its source; a "Sandbox" badge on every sandbox-only control; "Simulate PayPal's decision (sandbox only)" verbatim
- **Tokens:**
  - `docs/design/tokens.json` is the source of truth: colour (light and dark), type scale, spacing (4 px base), radius, elevation, motion (respects `prefers-reduced-motion`), breakpoints 375 / 768 / 1440 and z-index
  - status colours for COMPLETED, PENDING/held, in dispute, quarantined/error, info and sandbox, each paired with an **icon and a label** (never colour alone) and colour-blind safe
  - type: a Latin face plus **Noto Sans Devanagari** for HI, with line heights tuned for Devanagari matras. Numerals and currency formatting rules (`Intl.NumberFormat`, original and receivable currency side by side)
- **Tokens in code** (this is the design-system ticket): `apps/web/src/styles/tokens.css` as a Tailwind 4 `@theme` block generated from `tokens.json`, using `scripts/design-tokens.mjs` (build and `--check`)
- **Component specs** (`docs/design/components.md`): status badge, money cell, payment row, summary bar, citation chip (quote + source), "estimated" date, approval card (shows exactly what goes to PayPal and the draft hash), sandbox badge, empty/loading/error panels (error panels show the correlation ID), language switch, toast, and the audit log row. Each spec covers states, keyboard behaviour, focus ring and a 44 px minimum target on mobile
- **Hero-screen specs** in `docs/design/screens/<screen>.md`, each with purpose, layout at 375/768/1440, light and dark, components, all states (loading, empty, error, partial, success), interactions, EN and HI copy, and accessibility notes:
  - `landing.md`: "Try as demo seller" and seller sign-in by magic link (check-email state, expired-link state, cap-reached state)
  - `dashboard.md`: the hero wireframe from RESEARCH §9 / PROJECT.md. The summary line (held · in dispute · proof-ready), payment rows by attention, and the "agent does the work · you hold the keys · audit log" footer. It includes the **M1 subset** (payments list + "Create a sandbox test payment" empty state) and marks which parts arrive in M2/M3
  - `payment-detail.md` (proof pack, evidence, verdicts with citations), `dispute-review.md` (draft, evidence, approve, filing status, outcome wording), `hold.md` (explanation, estimated release, route advice), `cash-calendar.md`, `audit-log.md`, `notifications.md`
- **`docs/design/review-checklist.md`:** what `ui-reviewer` checks per ticket (axe serious/critical = blocking, the 375 px clip check, dark mode, HI rendering, forbidden copy)

## Out of scope
- Building any screen or component → M1-07 (dashboard) and the M2/M3 UI tickets
- Hindi translation of the full app → M4-03 (this ticket gives HI copy for the specified screens)
- The accessibility and performance audit of built UI → M4-04

## Acceptance Criteria
- [ ] Every file listed in Deliverables exists. Each `screens/*.md` contains the headings Purpose, Layout, Components, States, Interactions, Copy and Accessibility (`grep` check below)
- [ ] `node scripts/design-tokens.mjs --check` passes: `tokens.css` matches `tokens.json`, and **every text/background pair used for text has contrast ≥ 4.5:1 (≥ 3:1 for large text and UI boundaries) in light and dark**. The script computes WCAG ratios and exits 1 on a failure
- [ ] Every status token has an icon and a label in `components.md` (a script greps the status list from `tokens.json` against `components.md`)
- [ ] `dashboard.md` reproduces each element of the RESEARCH §9 hero wireframe and labels which ticket delivers it
- [ ] No forbidden copy: `grep -niE "seller (has )?won|won the dispute|guaranteed release"` over `docs/design` finds nothing
- [ ] Each screen spec states its 375 px behaviour and a keyboard path
- [ ] `./scripts/landing-checks.sh --fast` passes

## Deliverables
- `docs/design/{README.md,tokens.json,components.md,review-checklist.md}`
- `docs/design/screens/{landing,dashboard,payment-detail,dispute-review,hold,cash-calendar,audit-log,notifications}.md`
- `apps/web/src/styles/tokens.css`, `scripts/design-tokens.mjs`

## Validation Gate
```bash
node scripts/design-tokens.mjs --check | tee "$TMPDIR/m1-06-tokens.log"
for f in docs/design/screens/*.md; do for h in Purpose Layout Components States Interactions Copy Accessibility; do grep -q "^## $h" "$f" || { echo "missing $h in $f"; exit 1; }; done; done
for s in $(node -e "console.log(Object.keys(require('./docs/design/tokens.json').color.status).join(' '))"); do grep -qi "$s" docs/design/components.md || { echo "status $s unspecified"; exit 1; }; done
! grep -rniE "seller (has )?won|won the dispute|guaranteed release" docs/design
./scripts/landing-checks.sh --fast
```

## Handoff
- **M1-07** builds `landing.md` and the M1 subset of `dashboard.md` with `tokens.css`.
- **M2-05, M2-09, M3-01, M3-05, M3-08** build their screens from these specs.
- **`ui-reviewer`** uses `review-checklist.md` on every `frontend` ticket.
- Spec changes later go through `ux-designer`, never the builder.
