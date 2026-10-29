# Calendar spike (M0-09): Bryntum Calendar trial vs FullCalendar 7

Throwaway Next 16 / React 19 / TypeScript 6.0.3 app. It renders the same month of six synthetic
"expected release" events with each library, client-only (`next/dynamic` with `{ ssr: false }`),
behind one proposed `CashCalendar` props type (`src/cash-calendar.ts`).

Findings: [`docs/evidence/m0-09-bryntum-spike.md`](../../docs/evidence/m0-09-bryntum-spike.md).

## Isolation

- It is **not** in the repo's `pnpm-workspace.yaml`. Its own `pnpm-workspace.yaml` makes it a separate
  pnpm root with its own `pnpm-lock.yaml`, so the product's install, CI and Render builds never see it.
- Bryntum comes from **public npm** as a trial alias (owner decision 2026-10-29):
  `"@bryntum/calendar": "npm:@bryntum/calendar-trial@7.3.8"` + `@bryntum/calendar-react@7.3.8`.
  No registry login, no token, no `.npmrc`.
- The trial is commercial software under Bryntum's licence terms (internal evaluation only). The page
  shows Bryntum's trial watermark.

## Run

```bash
cd spikes/bryntum-calendar
pnpm install          # runs the two allow-listed Bryntum postinstall scripts (see pnpm-workspace.yaml)
pnpm build
pnpm start            # http://localhost:3100 (PORT overrides; 3000 + PORT_OFFSET 100)
```

Pages: `/bryntum`, `/fullcalendar`; add `?theme=dark` for dark mode.

## Measure

With `pnpm start` running:

```bash
BASE_URL=http://localhost:3100 pnpm measure
```

Writes `measure.json`, axe JSON per page and screenshots (1440 light/dark, 375) to the repo's
`.review/M0-09/` (gitignored). Uses the Playwright Chromium already installed for the repo (P-12).
