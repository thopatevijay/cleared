---
title: "M0-09 · Bryntum spike: Calendar trial in Next 16 / React 19 (client-only), watermark; FullCalendar fallback check"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon"]
blocked_by: ["M0-02"]
estimate: "2h"
resources: []
needs: []
---

## Context

The cash calendar (P2, Impact and Design) shows when held money is expected back, across payments.
It targets the Bryntum sponsor prize (3 × $1k) if Bryntum permits a public trial demo (M0-01;
decision 2026-11-04); otherwise FullCalendar (MIT) sits behind the same `CashCalendar` component and
only the sponsor prize is lost (`PROJECT.md` §10). Before M3-05 commits, we need facts: does the
Bryntum Calendar trial run in Next 16 App Router with React 19 as a client-only component, what the
trial watermark looks like on a judge-facing page, how the private npm registry reaches CI and
Render builds, and whether FullCalendar covers the same view.

## Scope

- A standalone throwaway app at `spikes/bryntum-calendar/` (Next 16, React 19, TS 6.0.3), **not**
  in `pnpm-workspace.yaml`, so the product's CI and Render builds never depend on Bryntum's registry
- Install `@bryntum/calendar` (trial) + `@bryntum/calendar-react` 7.3.8 from `npm.bryntum.com` with
  the owner's trial registry login (M0-00 decides whether to log in before 2026-11-01). The auth
  token lives only in the user-level `~/.npmrc`; the spike's `.npmrc` holds the scope→registry line only
- One page rendering a month view with 6 synthetic "expected release" events (amount, currency,
  "estimated" badge), loaded with `next/dynamic` `{ ssr: false }`; check for hydration warnings,
  React 19 peer-dep warnings, and Bryntum CSS/theme import in the App Router
- Record: install path and time, gzip JS added (from the build output), first-render time, the
  watermark/trial notice (screenshot to `.review/M0-09/`, gitignored), keyboard navigation and an
  axe run on the page (WCAG 2.2 AA issues listed), mobile width 375 px behaviour, dark mode
- The same view in FullCalendar (`@fullcalendar/react` 7.1.3 + `@fullcalendar/core` 7.1.3; check whether v7 still ships daygrid/list as separate plugins, whose latest is 6.1.22 as of 2026-10-28, and pin one consistent major;
  MIT), same data, same measurements
- Propose the `CashCalendar` props interface (events, locale, time zone, onSelect) that both
  implementations satisfy, and how a build gets the Bryntum registry token (an env name for the
  Render build and the GitHub Actions secret, used only if Bryntum is chosen) in the evidence doc

## Out of scope

- The product cash calendar and its data (M3-05); hold derivation (M3-01)
- Asking Bryntum for permission (M0-01); i18n of the calendar (M4-03)
- Adding Bryntum to the product workspace, CI or Render (M3-05, after the 2026-11-04 decision)

## Acceptance Criteria

- [ ] Both spike pages build (`next build`) and render the 6 events with no hydration errors
- [ ] `docs/evidence/m0-09-bryntum-spike.md` compares Bryntum vs FullCalendar: bundle size, render time, a11y (axe count + keyboard), 375 px behaviour, watermark, licence terms quoted with the source
- [ ] Watermark/trial notice documented with a screenshot under `.review/M0-09/` (not tracked)
- [ ] The proposed `CashCalendar` interface is written in the evidence doc
- [ ] No Bryntum registry token anywhere in the repo; `spikes/bryntum-calendar/` is outside the pnpm workspace
- [ ] A recommendation for M3-05 with the decision rule tied to the M0-01 answer

## Deliverables

- `spikes/bryntum-calendar/` (README with how to run; no tokens)
- `docs/evidence/m0-09-bryntum-spike.md`; screenshots in `.review/M0-09/` (gitignored)

## Validation Gate

```bash
grep -c 'spikes' pnpm-workspace.yaml                                     # expect 0
( cd spikes/bryntum-calendar && pnpm install && pnpm build ) 2>&1 | tee "$TMPDIR/m0-09-build.log" | tail -20
grep -ciE 'hydration|error' "$TMPDIR/m0-09-build.log"                     # expect 0
grep -rn '_authToken' spikes/ | wc -l                                    # expect 0 (token only in ~/.npmrc)
git ls-files .review | wc -l                                             # expect 0
ls docs/evidence/m0-09-bryntum-spike.md
./scripts/check-no-secrets.sh
```

## Handoff

- **M3-05:** the `CashCalendar` interface, both implementations' findings, the registry-token plan, and the recommendation (Bryntum only with written permission by 2026-11-04)
- **M0-01:** the watermark screenshot helps phrase the Bryntum question
- **M1-06:** the calendar's a11y and mobile findings for the design system
- **M5-CLEANUP:** decides whether `spikes/` stays in the public tree
