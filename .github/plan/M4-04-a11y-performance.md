---
title: "M4-04 · Accessibility + performance pass (WCAG 2.2 AA, CWV budget)"
milestone: "M4 · Trust & Global"
labels: ["frontend"]
blocked_by: ["M4-03"]
estimate: "4h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14, P-54]
---

## Context

The Design criterion rewards a coherent, accessible, mobile-first journey (PROJECT.md rubric table). Sellers in the target markets often use low-end Android phones on slow networks. Architecture §1 fixes WCAG 2.2 AA and a dashboard p95 < 800 ms; engineering standards §3.5 require a Core Web Vitals budget. This pass proves both, across every screen, in EN and HI.

## Scope

- **Automated accessibility:** `@axe-core/playwright` runs on every route (dashboard, payment and proof pack, hold, dispute, cash calendar, notifications, settings, sign-in, client acknowledgement page, demo landing). It runs in both locales and in each screen's empty, loading and error state
- **WCAG 2.2 specifics checked by tests or a recorded manual pass:**
  - 2.4.11 focus not obscured (sticky headers)
  - 2.5.7 dragging alternative (cash calendar: every drag has a button or menu path)
  - 2.5.8 target size ≥ 24×24 px
  - 3.3.7 redundant entry
  - 3.3.8 accessible authentication (magic link, no puzzle)
  - status messages through `aria-live` (pack checking, filing status, "pending at PayPal")
  - reflow at 320 CSS px and 200% zoom
  - `prefers-reduced-motion` honoured
  - contrast for all tokens, light and dark if both exist
- **Keyboard-only** Playwright run of the judge path end to end (Tab, Enter and Space only), with visible focus at each step
- **Manual screen-reader pass** (VoiceOver on macOS and iOS Safari) of the judge path, recorded as a checklist in `docs/evidence/a11y-report.md`
- **Performance budget** (mobile, Lighthouse "Slow 4G" + 4× CPU) on the production build: LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms (the lab proxy for INP ≤ 200 ms), first-load JS ≤ 200 KB gzip on the dashboard. The Bryntum `CashCalendar` is client-only and lazy-loaded, outside the dashboard budget
- **Lighthouse CI** (`@lhci/cli`) asserts the budget in CI on the main routes against a local production build with seeded data
- **Field metrics:** `useReportWebVitals` reports LCP, INP and CLS to the existing logging/Sentry path, with no new vendor
- Fix every finding (serious or critical axe violations, budget misses). Minor findings are fixed or logged in BL-01 with a reason. Pass `ui-reviewer`

## Out of scope

- Hindi coverage and formatting (M4-03)
- API latency under concurrent load (M4-06)
- New screens or visual redesign (only fixes against `docs/design/`)

## Acceptance Criteria

- [ ] `pnpm --filter @cleared/web exec playwright test e2e/a11y.spec.ts` reports 0 serious or critical axe violations on every route × {en, hi} × {empty, loading, error, populated}
- [ ] The keyboard-only judge-path spec passes. Every interactive step asserts a visible focus indicator
- [ ] The target-size test finds no interactive element < 24×24 px (except inline text links, which are exempt). The reflow test at 320 px finds no horizontal scroll
- [ ] The cash calendar spec completes every drag action through its non-drag alternative
- [ ] `pnpm lhci autorun` passes the assertions (LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms) on the main routes. Bundle analysis shows dashboard first-load JS ≤ 200 KB gzip
- [ ] `docs/evidence/a11y-report.md` lists the screen-reader checklist results and every fixed finding
- [ ] `ui-reviewer` passes

## Deliverables

- `apps/web/e2e/{a11y,keyboard-judge-path,target-size,reflow}.spec.ts`
- `lighthouserc.json`, a CI job `lhci` in the PR CI workflow (hot file `.github/workflows/*`)
- `apps/web/app/web-vitals.tsx`
- `docs/evidence/a11y-report.md`, `docs/evidence/perf-report.md`
- Fixes in `apps/web/app/**` and `apps/web/src/**`

## Validation Gate

```bash
set -euo pipefail
pnpm install --frozen-lockfile
make up && pnpm db:migrate && pnpm db:seed
pnpm --filter @cleared/web build
pnpm --filter @cleared/web exec playwright test e2e/a11y.spec.ts e2e/keyboard-judge-path.spec.ts e2e/target-size.spec.ts e2e/reflow.spec.ts --output "$TMPDIR/pw-a11y"
pnpm lhci autorun --upload.target=filesystem --upload.outputDir="$TMPDIR/lhci"
pnpm --filter @cleared/web analyze --json > "$TMPDIR/bundle.json"
node -e 'const b=require(process.argv[1]);if(b.dashboardFirstLoadGzipKB>200)process.exit(1)' "$TMPDIR/bundle.json"
```

## Handoff

- **M4-GATE** re-runs the axe and Lighthouse checks from a clean stack
- **M5-01** cites `docs/evidence/a11y-report.md` and `perf-report.md` under Design ("WCAG 2.2 AA, measured")
- **M4-06** reuses the seeded data and routes for the launch-load read paths
