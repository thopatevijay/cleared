# Performance report (M4-04): Core Web Vitals budget, measured

Ticket: M4-04 (#48). Budget (engineering standards §3.5, architecture §1): on Lighthouse's mobile preset
(simulated **Slow 4G**: 150 ms RTT, 1.6 Mbps; **4× CPU** slowdown), LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 200 ms
(the lab proxy for INP ≤ 200 ms), and first-load JS ≤ 200 KB gzip on the dashboard. The Bryntum
`CashCalendar` is client-only, loaded at runtime from `/vendor`, and outside the dashboard budget.

## How it is measured

- **Lab:** `pnpm lhci autorun` (`apps/web/scripts/lhci.ts` + `lighthouserc.json`). The wrapper starts the
  local production build (`next start`) and the worker on the msw PayPal stub, creates a demo seller,
  seeds the judge path (a checked pack, a hold, a dispute with its draft, notifications, a scenario run),
  then runs Lighthouse 3 times per URL (median run asserted): `/en` without a session, then `/en/payments`,
  `/hi/payments`, the proof pack, `/en/holds`, a hold, a dispute review and `/en/calendar` with the
  session cookie. CI job `lhci` runs the same command on every PR.
- **Bundle:** `pnpm --filter @cleared/web analyze --json` gzips (level 9) each route's first-load chunks
  as Next lists them in `.next/diagnostics/route-bundle-stats.json` (root main files + the route's entry
  chunks).
- **Field:** `apps/web/app/web-vitals.tsx` (`useReportWebVitals`) sends LCP, INP and CLS to Sentry as
  distribution metrics `web_vitals.{lcp,inp,cls}` with the route as a pattern (`/en/holds/:id`), the
  rating and the navigation type. No new vendor; nothing is sent without a DSN.

These are local measurements on a MacBook (Apple silicon), not production: M4-06 load-tests production
in parallel, so production was not measured here.

## Lab results (2026-11-03, this branch, median of 3 runs)

| URL | LCP ms (≤ 2500) | CLS (≤ 0.1) | TBT ms (≤ 200) | FCP ms |
|---|---|---|---|---|
| `/en` | 2799 | 0.000 | 71 | 1058 |
| `/en/payments` | 5707 | 0.066 | 104 | 1056 |
| `/hi/payments` | 8365 | 0.000 | 110 | 1956 |
| `/en/payments/:id/pack` | 5738 | 0.000 | 180 | 1054 |
| `/en/holds` | 3613 | 0.075 | 100 | 1055 |
| `/en/holds/:id` | 5564 | 0.000 | 142 | 1055 |
| `/en/disputes/:id` | 5715 | 0.000 | 119 | 1054 |
| `/en/calendar` | 2704 | 0.000 | 82 | 1054 |

**CLS and TBT pass on every route. LCP fails on every route.** Before this ticket (main @ 5169496, same
command) LCP was 4.8 to 8.0 s and CLS reached 0.237 (dashboard), 0.171 (pack, hold) and 0.148 (dispute).

Fixed here:
- **CLS:** the footer was pushed down inside the viewport when data replaced a short skeleton. `main`
  now fills the viewport (`globals.css`), so the footer starts below the fold.
- **LCP / first load:** Sentry left the first-load bundle (−71 KB gzip on the dashboard, measured); the
  118 KB Noto Sans Devanagari and the mono font are no longer preloaded on every page.

Why LCP still misses, measured:
1. **JavaScript size drives the simulated LCP.** On localhost the unthrottled trace has loaded every
   async script before the first paint (observed LCP 77 ms; last script done at 64 ms), so Lighthouse's
   simulation puts them all in LCP's dependency graph. LCP then tracks the first-load JS (§ Bundle). On
   `/en` the LCP element is server-rendered text that is painted at FCP (1.06 s).
2. **Client-rendered data screens.** On the dashboard, pack, hold detail and dispute review the LCP
   element is drawn after hydration and the first SWR fetch. A diagnostic run with DevTools throttling
   (same Slow 4G + 4× CPU, 1 run) measured `/en`, `/hi/payments`, `/en/holds` and `/en/calendar` at
   1.5 s, but those four data screens at 5.0 s. (The dashboard's 5 s poll keeps the network busy, so
   DevTools mode can't compute TBT there. That is why `lighthouserc.json` keeps the default simulation.)

Meeting the budget needs decisions beyond this ticket's scope (BL-01 6604185841): drop the crypto
polyfill (BL-01 6601208506, M4-06); keep zod out of the client's first load; server-render each data
screen's first response; or revise the budget.

## Bundle: dashboard first-load JS

| Build | Dashboard first-load (gzip) | Budget |
|---|---|---|
| main @ 5169496 (before) | **451.8 KB** | 200 KB |
| this branch | **380.9 KB** | 200 KB: **missed** |

Where the 380.9 KB goes (gzip, from the chunks themselves):

| Part | ≈ KB gz | Owner |
|---|---|---|
| Next 16 + React 19 runtime (root main files; every route, `/_not-found` alone is 133 KB) | 133 | framework |
| crypto-browserify, bn.js, asn1.js, `Buffer` polyfills, pulled in by `@cleared/core`'s barrel (`agent/canonical-hash.ts` imports `node:crypto`) | ≈ 124 | **BL-01 6601208506 → M4-06** (not fixed here, as briefed) |
| zod 4 + `@cleared/core` schemas and formatters, shared by every page | ≈ 68 | |
| dashboard's own components, next-intl, swr, lucide icons | ≈ 56 | |

Fixed here: the Sentry browser SDK (≈ 55 KB gz on every page) left the first load. It now loads after
the page's `load` event (`instrumentation-client.ts`); errors thrown before that are buffered and sent
once it is up.

Even with BL-01 6601208506 fixed, the dashboard would be ≈ 257 KB: the budget also needs zod out of the
client's first load (a client-side schema subset, or `zod/mini`), which changes how every screen parses
API responses. That is a decision for the owner/manager, not a fix inside this ticket.
