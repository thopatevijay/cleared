---
title: "M3-05 · Cash calendar (Bryntum via CashCalendar)"
milestone: "M3 · Holds & Cash"
labels: [frontend, backend]
blocked_by: [M3-01]
estimate: "5h"
resources: []
needs: [P-01, P-02, P-03, P-04, P-05, P-07, P-12, P-14, P-37, P-38, P-39, P-45]
---

## Context
PayPal already shows one release date per payment (sandbox UI, 2026-10-28). The calendar must add value **across** payments: when held money is expected back, totals per day and currency, and dispute deadlines next to releases. This is the storyboard's 1:50–2:15 scene. It serves pillar P2 → **Impact**, **Design**, and the Bryntum sponsor prize. ADR 0016 (owner decision 2026-10-29): **Bryntum Calendar only**, behind `CashCalendar`; no FullCalendar fallback. This ticket starts only after Bryntum's written OK for the public demo is recorded (P-38, required), because merges to `main` deploy publicly. The M0-09 spike proved Bryntum runs client-only in Next 16/React 19; read its handoff on #11 (`timeZone` all-day shift, obfuscated postinstall, axe findings, Hindi locale).

## Scope
- `GET /api/cash-calendar?from&to` (workspace-scoped, zod, offset-free; the range is capped at 92 days) returns events. Event kinds:
  - `estimated_release`: hold amount, currency, `estimatedReleaseAt`, rule id + source
  - `dispute_deadline`: `seller_response_due_date`
  - `released`: actual release time
  - `service_completed_due`: Completed + 7 days
- It also returns per-day totals per currency (never summed across currencies) and the total held now.
- `CashCalendar` (`apps/web/components/cash-calendar/`) has a typed, engine-neutral props interface: events, totals, locale, tz, and an onSelect callback. Its implementation is `BryntumCashCalendar`: `@bryntum/calendar-react`, loaded via `next/dynamic` with `ssr: false`, in month and agenda modes. Event colour is by kind. Day cells show totals. Bryntum's own a11y keyboard nav is kept. Installed as `"@bryntum/calendar": "npm:@bryntum/calendar-trial@7.3.8"` + `@bryntum/calendar-react@7.3.8`, unless Bryntum's answer gives another route (a licence key or registry access, P-39). Record that route in `apps/web/config/cash-calendar.ts` with its date and source.
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
- [ ] A contract test renders `CashCalendar` with a props fixture and asserts the event count and titles
- [ ] Bryntum's written permission (P-38) is linked in `apps/web/config/cash-calendar.ts` before the PR merges
- [ ] Playwright: month view on desktop, list view at 360 px, keyboard navigation reaches every event, axe shows no WCAG 2.2 AA violations
- [ ] The text-alternative table lists every event in the range
- [ ] `pnpm --filter ./apps/web build` succeeds (client-only import, no SSR errors)
- [ ] `ui-reviewer` passes against `docs/design/`

## Deliverables
- `apps/web/app/api/cash-calendar/route.ts`, `packages/core/src/cash/calendar.ts` (+ tests)
- `apps/web/components/cash-calendar/{index.tsx,bryntum.tsx,list.tsx,types.ts}`
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
- M5-03 names Bryntum (sponsor prize) and links the written permission
