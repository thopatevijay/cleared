---
title: "M3-05 · Cash calendar (Bryntum via CashCalendar)"
milestone: "M3 · Holds & Cash"
labels: [frontend, backend]
blocked_by: [M3-01]
estimate: "5h"
resources: []
needs: []
---

## Context
PayPal already shows one release date per payment (sandbox UI, 2026-10-28). The calendar must add value **across** payments: when held money is expected back, totals per day and currency, and dispute deadlines next to releases. This is the storyboard's 1:50–2:15 scene. It serves pillar P2 → **Impact**, **Design**, and the Bryntum sponsor prize. ADR 0005: one Bryntum Calendar behind `CashCalendar`, with a FullCalendar (MIT) fallback. **Licence decision 2026-11-04** (M0-01 question; the M0-09 spike proved both run client-only in Next 16/React 19).

## Scope
- `GET /api/cash-calendar?from&to` (workspace-scoped, zod, offset-free; the range is capped at 92 days) returns events. Event kinds:
  - `estimated_release`: hold amount, currency, `estimatedReleaseAt`, rule id + source
  - `dispute_deadline`: `seller_response_due_date`
  - `released`: actual release time
  - `service_completed_due`: Completed + 7 days
- It also returns per-day totals per currency (never summed across currencies) and the total held now.
- `CashCalendar` (`apps/web/components/cash-calendar/`) has a typed, engine-neutral props interface: events, totals, locale, tz, and an onSelect callback. It has two implementations:
  - `BryntumCashCalendar`: `@bryntum/calendar-react`, loaded via `next/dynamic` with `ssr: false`, in month and agenda modes. Event colour is by kind. Day cells show totals. Bryntum's own a11y keyboard nav is kept.
  - `FullCalendarCashCalendar`: `@fullcalendar/react` with the daygrid and list plugins, at the same props parity.
- The engine is chosen by one constant in `apps/web/config/cash-calendar.ts`. Its default is `bryntum`, flipped on 2026-11-04 if no written licence OK arrives; the decision is recorded in that file with its date and source.
- Mobile (< 640 px): an agenda/list view by default.
- An accessible text alternative: a "list of upcoming releases" table for every engine, so screen readers and the no-JS path still work.
- All dates are UTC in data and shown in the workspace tz. Amounts are in the PayPal-returned currency (formatting polish is M4-03).
- Every estimate carries an "estimated" label and a source disclosure (M3-01 rule).
- Selecting an event opens the hold or dispute detail.
- Empty state ("No held money"), plus loading and error states.
- The Bryntum trial watermark is noted in the PR with a screenshot. No licence key is committed.

## Out of scope
- Licence email/decision itself: M0-01 (owner)
- FX conversion of totals: future v3
- Alerts: M3-08
- Hindi copy and number formatting pass: M4-03
- Performance budget pass: M4-04

## Acceptance Criteria
- [ ] Integration test: the API returns the expected events and per-currency totals for a seeded workspace with a `PENDING_REVIEW` hold, a `BUYER_COMPLAINT` hold + dispute deadline, and a released hold; a foreign workspace's data is never returned
- [ ] A contract test renders both engines with the same props fixture and asserts the same event count and titles
- [ ] Flipping the config constant switches the engine with no other code change (test)
- [ ] Playwright: month view on desktop, list view at 360 px, keyboard navigation reaches every event, axe shows no WCAG 2.2 AA violations (both engines)
- [ ] The text-alternative table lists every event in the range
- [ ] `pnpm --filter ./apps/web build` succeeds (client-only import, no SSR errors)
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `apps/web/app/api/cash-calendar/route.ts`, `packages/core/src/cash/calendar.ts` (+ tests)
- `apps/web/components/cash-calendar/{index.tsx,bryntum.tsx,fullcalendar.tsx,list.tsx,types.ts}`
- `apps/web/config/cash-calendar.ts`, `apps/web/app/[locale]/calendar/page.tsx`
- `apps/web/e2e/cash-calendar.spec.ts`, message keys

## Validation Gate
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter ./packages/core test -- calendar
pnpm --filter ./apps/web test -- cash-calendar
pnpm --filter ./apps/web build > "$TMPDIR/m3-05-build.txt" 2>&1; tail -3 "$TMPDIR/m3-05-build.txt"
pnpm --filter ./apps/web exec playwright test e2e/cash-calendar.spec.ts --reporter=line > "$TMPDIR/m3-05-e2e.txt"; tail -5 "$TMPDIR/m3-05-e2e.txt"
./scripts/landing-checks.sh --fast
```

## Handoff
- M3-11 and the video (M5-02) show the calendar
- M4-03 formats dates and amounts in it
- M4-04 measures its CWV
- M5-03 names Bryntum (or FullCalendar) per the 2026-11-04 decision
