# Performance report (M4-04): Core Web Vitals budget, measured

Ticket: M4-04 (#48). Budget (engineering standards §3.5, architecture §1): on Lighthouse's mobile preset
(simulated **Slow 4G**: 150 ms RTT, 1.6 Mbps; **4× CPU** slowdown), LCP ≤ 3.2 s (revised from 2.5 s by the owner, issue #142, 2026-11-04; claim wording: "LCP ≤ 3.2 s, Lighthouse mobile simulation, localhost"), CLS ≤ 0.1, TBT ≤ 200 ms
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

## M4-08 follow-up (2026-11-03): zod out of the first load, data screens rendered on the server

Ticket M4-08 (#142), stacked on this branch with `main` merged in (that brings #138's removal of the crypto
polyfill). The thresholds are unchanged.

### What changed

- **zod and the response schemas left every first load.** Client fetchers parse through
  `apps/web/src/lib/schemas.ts`, which loads on demand (`getParsed` / `loadSchemas` in `lib/api.ts`) the
  first time a screen refreshes or posts. `@cleared/core` declares `sideEffects` (only the three prompt
  registrations keep theirs). The helpers that the browser uses moved into modules without zod, and the
  original modules re-export them, so `index.ts` didn't change:
  - `currency.ts`, `instant.ts`
  - `holds/kinds.ts`, `holds/completed-quotes.ts`
  - `scenarios/states.ts`, `cash/days.ts`
  - `lib/dispute-helpers.ts`
- **The first view comes with the HTML.** The dashboard, the proof pack, the hold detail and the dispute
  review call their API route's own handler on the server (`src/server/first-view.ts`). The body goes to
  the client as SWR's `fallback`, under the route's own key, so the queries and the authZ aren't
  duplicated. Nothing changed in the client components; SWR still refreshes on mount and on its poll. A
  non-200 gives no fallback, and the client then shows its loading and error states as before. The local
  e2e run turns the first view off for one load with a cookie that only `E2E_FIRST_VIEW_SWITCH=1`
  (playwright.config.ts) honours, so the a11y matrix still checks loading and error.

### Bundle (`pnpm --filter @cleared/web analyze --json`, gzip)

| Route | M4-04 branch + main (before) | M4-08 |
|---|---:|---:|
| **dashboard `/[locale]/payments`** (budget 200) | 256.2 KB | **185.0 KB** |
| `/[locale]/payments/[paymentId]/pack` | 264.3 | 192.4 |
| `/[locale]/holds/[holdId]` | 262.5 | 191.0 |
| `/[locale]/disputes/[disputeId]` | 255.8 | 181.7 |
| `/[locale]/holds` | 251.5 | 179.2 |
| `/[locale]/calendar` | 249.6 | 175.5 |
| `/[locale]` | 243.7 | 170.9 |

The dashboard's budget is met. The browser source map shows no zod module in any first-load chunk.

### Lab (`pnpm lhci autorun`, median of 3; the machine idle during the run)

| URL | LCP before (M4-04 table) | LCP M4-08 | FCP | TBT | CLS |
|---|---:|---:|---:|---:|---:|
| `/en` | 2799 | 2708 | 1058 | 56 | 0.000 |
| `/en/payments` | 5707 | 3101 | 1362 | 104 | 0.000 |
| `/hi/payments` | 8365 | 10096 | 2114 | 80 | **0.201** |
| `/en/payments/:id/pack` | 5738 | 3105 | 1354 | 99 | 0.000 |
| `/en/holds` | 3613 | 2980 | 1061 | 129 | 0.075 |
| `/en/holds/:id` | 5564 | 3087 | 1361 | 72 | 0.000 |
| `/en/disputes/:id` | 5715 | 3115 | 1356 | 108 | 0.000 |
| `/en/calendar` | 2704 | 2795 | 1057 | 35 | 0.000 |

**TBT passes everywhere. LCP still misses on every route (budget 2500 ms), and `pnpm lhci autorun` exits 1.**
An earlier run with builds running on the same machine measured TBT at 335–794 ms. Lighthouse's
simulation scales the observed main-thread tasks, so a lab run needs an idle machine.

What is left, measured from the LHRs:
- **The data screens:** their LCP element is now in the HTML, at 3.1 s instead of 5.1–5.7 s. The rest is
  "render delay": on `/en`, TTFB is 452 ms and the render delay 2,345 ms. On localhost every early request
  is in LCP's simulated dependency graph: the document, two preloaded woff2 fonts (53 KB), the CSS, and
  ≈ 179 KB of first-load JS, of which the Next 16 + React 19 runtime alone is 133 KB. The server-rendered
  data also makes the document heavier (FCP 1.36 s against 1.06 s on `/en`).
- **`/en` and `/en/calendar`** already had a server-rendered LCP element, and they stay at 2.7–2.8 s with
  171–176 KB of JS. So with Lighthouse's localhost simulation, this stack's floor is above 2.5 s, whatever
  the data screens do.
- **`/hi/payments`** ends on `/hi?ended=1` in the Lighthouse run: a session check redirected it to the
  landing page. With `curl`, the same kind of cookie gets a 200 on `/hi/payments`. The cause isn't found
  yet. On the landing page, the Devanagari text waits for its web font: LCP 10.1 s, CLS 0.20.
  The M4-04 run had 8.4 s on the same URL. This is logged on BL-01. It is not a data-route issue.

Meeting LCP ≤ 2.5 s needs one of these, each beyond this ticket:
- Cut the runtime's share: no client components on first paint, or a lighter framework build.
- Stop preloading the Latin fonts.
- Measure LCP with DevTools throttling against a deployed origin, where the trace is real (M4-04 measured
  the server-rendered pages at 1.5 s that way).
- An owner decision on the budget's method.

## M4-08 follow-up: budget revised, and the signed-in runs fixed (2026-11-04)
- **LCP budget:** ≤ 3.2 s, owner decision on issue #142, 2026-11-04. Claim wording: "LCP ≤ 3.2 s, Lighthouse
  mobile simulation, localhost". CLS, TBT, throttling and runs are unchanged.
- **Why `/hi/payments` landed on `/hi?ended=1` (BL-01 6609549510):** the wrapper passed the session as an
  `extraHeaders` Cookie. That reaches the document request only; Chrome builds the Cookie header of the page's
  own `fetch` calls from its cookie jar, so every `/api/*` call returned 401 and the client sent the page to
  `/<locale>?ended=1`. The signed-in rows above were measured with the first view server-rendered and the client
  data calls failing. It is not specific to Hindi. Now `apps/web/scripts/lhci-session.cjs` (an lhci
  `puppeteerScript`) puts the cookie in the jar, with `disableStorageReset`, one browser per URL.
  Every signed-in run now ends on its own URL.
