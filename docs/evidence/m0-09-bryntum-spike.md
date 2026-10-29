# M0-09 · Bryntum Calendar spike, FullCalendar fallback check

Ticket M0-09 (#11) · spike app: [`spikes/bryntum-calendar/`](../../spikes/bryntum-calendar/) · run 2026-10-29

**Owner-approved deviation.** The ticket installs Bryntum from `npm.bryntum.com` with the owner's
trial registry login. The owner decided on 2026-10-29 (issue #11 comment, PR #77) to install the trial
from **public npm** instead: `"@bryntum/calendar": "npm:@bryntum/calendar-trial@7.3.8"` +
`"@bryntum/calendar-react": "7.3.8"`. No registry login, no token, nothing in `~/.npmrc`. P-37 now
checks that these packages resolve from public npm.

## Result in one paragraph

Both libraries run in Next 16.4.3 App Router with React 19.3.1 as client-only components
(`next/dynamic`, `{ ssr: false }`). Both pages build and render all 6 events with no hydration error
and no console warning. FullCalendar 7.1.3 adds **58 KiB** gzip JS and renders in **314 ms**.
Bryntum 7.3.8 (trial) adds **1.54 MiB** gzip JS and renders in **433 ms**. On this page, Bryntum
has a tiled "Bryntum / Trial Version" watermark across the whole month grid. Its licence allows
the trial only for **internal evaluation**, so a public judge demo needs Bryntum's written OK
(M0-01). FullCalendar is MIT. **Recommendation:** build M3-05 on FullCalendar behind
`CashCalendar`. Use Bryntum only if M0-01 has a written OK by 2026-11-04 (rule below).

## Setup

| | Bryntum | FullCalendar |
|---|---|---|
| Packages | `@bryntum/calendar` → `npm:@bryntum/calendar-trial@7.3.8` (+ `@bryntum/calendar-trial-lib@1.0.1`, transitive), `@bryntum/calendar-react@7.3.8` | `@fullcalendar/react@7.1.3` (pulls `@fullcalendar/core@7.1.3` and `@full-ui/headless-calendar@7.1.3`), peer `temporal-polyfill@1.0.6` |
| Licence (npm `license` field) | `Commercial` (both packages) | `MIT` |
| Packed / unpacked size | trial 8.6 MB / 37 MB; react wrapper 1.55 MB / 8.5 MB | react 253 KB / 1.9 MB |
| Views used | `mode="month"`, other modes off, `sidebar={false}`, `readOnly` | `dayGridPlugin` (`@fullcalendar/react/daygrid`), classic theme |
| CSS in App Router | `calendar.css` + `svalbard-light.css` + FontAwesome `fontawesome.css`/`solid.css`, imported in the client component: works | `skeleton.css` + `themes/classic/theme.css` + `palette.css`: works |
| Peer-dep warnings (React 19) | none (`calendar-react` declares no peers) | none (`react: ^17 \|\| ^18 \|\| ^19`) |
| Install scripts | **yes**: obfuscated `postinstall` in `calendar-trial` and `calendar-trial-lib` (below). pnpm 12 fails the install until they are listed in `allowBuilds` | none |

**FullCalendar v7 packaging (ticket question).** v7 no longer ships daygrid/list as separate plugin
packages. They are subpaths of `@fullcalendar/react`: `/daygrid`, `/timegrid`, `/list`, `/multimonth`,
`/interaction`, and the themes `/themes/{classic,monarch,breezy,forma,pulse}` (package `exports`, 7.1.3).
The separate `@fullcalendar/daygrid` and `@fullcalendar/list` packages stop at 6.1.22 (`latest` dist-tag,
checked 2026-10-29). The package README says: "The separate `@fullcalendar/core`,
`@fullcalendar/daygrid`, `@fullcalendar/interaction` (etc.) packages are FullCalendar v6. Don't
install them with v7". **Pinned major: 7 throughout** (`@fullcalendar/react@7.1.3` only; core comes
transitively at 7.1.3). `PROJECT.md` §4 is updated.

**Bryntum install scripts.** `@bryntum/calendar-trial`'s `postinstall.js` runs
`@bryntum/calendar-trial-lib/build.js`. That lib's own `postinstall` writes a random UUID into
`build.js`. `build.js` is obfuscated. Its string table and calls show what it does: it walks
`process.cwd()` (the package dir), and in every `.js` file it replaces `%LICENSE%` with that
UUID (`readdirSync`, `isDirectory`, `endsWith('.js')`, `readFileSync`, `replace`,
`writeFileSync`). It made no network call in the code read. The spike allows both scripts in its
own `pnpm-workspace.yaml` (`allowBuilds`). If the product ever adds Bryntum, it needs the same two
entries. That is an obfuscated script running in the product build.

**Release age.** pnpm 12 added `minimumReleaseAgeExclude` entries for both Bryntum 7.3.8 packages on
the first install. They were published 2026-10-28 08:56 UTC, one day before this run, inside pnpm's
minimum release age. No action is needed for M3-05 (by then they are older).

## Measurements

Environment: Apple M4, Node 24.22.1, `next build` + `next start` (production, Turbopack), Playwright
1.64.1 with Chromium 156.0.8078.4 headless on localhost, browser zone `Asia/Kolkata`. Numbers come from
`spikes/bryntum-calendar/scripts/measure.mjs` (`measure.json` in `.review/M0-09/`). These are local
numbers, not Render.

| | Bryntum 7.3.8 trial | FullCalendar 7.1.3 |
|---|---|---|
| Install | 27 s cold for the whole spike (41 packages, empty store; `next` is 43.6 MB of it); 0.24 s from a warm store | same install |
| JS loaded, page total (gzip -9 of every script response) | 1,754,767 B (9 files) | 198,093 B (9 files) |
| **JS added vs the no-calendar page** (138,565 B gzip) | **+1,616,202 B gzip (1.54 MiB)**, +4.23 MB raw | **+59,528 B gzip (58 KiB)**, +207 KB raw |
| **First render** (navigation start → 6 events in the DOM), median of 5 cold contexts | **433 ms** (430–435) | **314 ms** (311–315) |
| Events rendered | 6/6 | 6/6 |
| Hydration errors / console errors or warnings (6 loads per page) | 0 / 0 | 0 / 0 |
| axe (WCAG 2.0/2.1 A+AA, 2.2 AA), 1440 light | 2 rules: `label-content-name-mismatch` (serious, 84 nodes: day cells' `aria-label` omits their visible text), `color-contrast` (serious, 9 nodes: red weekend headers #e53935 on white, 4.22:1) | 1 rule: `color-contrast` (serious, 14 nodes: white on the default event blue #3788d8, 3.69:1) |
| axe, 375 px | the same 2 + `button-name` (**critical**, 1: the "Today" button turns icon-only and has no name) | `color-contrast` (serious, 4 nodes) |
| axe, dark | the same 2 as light (weekend red on #1a1a1a, 4.11:1) | the same as light (14 nodes) |
| Keyboard | Tab reaches toolbar → each **day cell** (`role=link`) and each event (`role=button`); arrow keys move focus in the grid. **Enter on a focused event did not fire `onEventClick`**, so `onSelect` needs a keyboard handler | Tab reaches each event (`role=button`); **Enter selects** (`onSelect` fired). Day cells are not focusable; arrow keys do nothing |
| 375 px | no horizontal scroll (scrollWidth 375). The month fits. Event chips are cut to the amount prefix ("$1,18", "€95.(") and the "estimated" badge is hidden | no horizontal scroll. Event text wraps inside the chip ("$1,180.5… Website #1051"). The badge is cut off at the right edge |
| Dark mode | `svalbard-dark.css` loaded after the light theme (Bryntum 7 themes are `:root` variable sets): works. Watermark still visible | `data-color-scheme="dark"` on a wrapper (the classic palette defines dark variables): works |
| Estimated badge, 1440 | hidden: Bryntum's month event bar is one line and cuts our label | visible on every estimated event |

All-day events and time zones (`dayPlacement` in `measure.json`): with `timeZone="Asia/Kolkata"`
passed to `BryntumCalendar`, every event moved **+1 day** in an `America/Los_Angeles` browser
(e.g. SYN-CAP-001 on 2026-11-05 instead of 2026-11-04; `measure-with-bryntum-timezone-prop.json`).
Without the prop, all 6 events sit on their date in `Asia/Kolkata`, `America/Los_Angeles` and
`Pacific/Auckland`. FullCalendar with `timeZone="Asia/Kolkata"` and date-only `start` values kept
every event on its date in all three zones. So `ReleaseEvent.date` should be a day already resolved
in the workspace zone, and the Bryntum adapter must not pass `timeZone` for all-day events.

Fixability, both libraries: the contrast items are theme variables (`--fc-classic-primary` /
`--fc-classic-event`; Bryntum's weekend colour). Bryntum's `label-content-name-mismatch` and the
375 px `button-name` come from its own DOM. They need configuration or overrides that this spike did
not try.

## Watermark and trial notice

Screenshot: `.review/M0-09/bryntum-1440-light.png` (also `-1440-dark`, `-375-light`), local and
gitignored.

- Light-grey "Bryntum" and "Trial Version" text, tiled diagonally across the **whole month grid**
  (every cell, behind the events), in light and dark. It is a CSS `background-image` (an inline
  base64 SVG) on `.b-weeks-container`, not a DOM element or a banner.
- No popup, banner or console notice on load. Events stay readable. The watermark is plainly
  visible on a judge-facing screen and in a demo video.
- FullCalendar: no watermark.

For M0-01: "a faint diagonal 'Bryntum / Trial Version' text tiled across the calendar body" is an
accurate description to send with the question.

## Licence terms

**Bryntum.** The npm `license` field is `Commercial`. The README says: "Bryntum Calendar is commercial
software and requires a paid license. Please visit the [Bryntum Calendar End User
License](https://bryntum.com/products/license/) for the full text of the license." The licence that
ships in the package (`@bryntum/calendar-react/license.pdf`, "Licence Terms (v39)") is byte-identical
(`cmp`) to the `license.pdf` in the owner's official trial download (`calendar-7.3.8-trial`, trial
registered 2026-10-29 by the owner). Clause 4, *Trial Licence*:

> 4.2 (a) … the Licensor instead grants the Licensee and its Affiliates a revocable, non-exclusive,
> non-transferable and non-sublicensable licence to install, load, launch, access, run, execute,
> operate, and archive the Software Materials … solely for the Licensee's and its Affiliates'
> internal evaluation and review purposes to determine whether to enter into a paid licence of the
> Software and not for any other purpose;

> 4.2 (b) … shall continue: (i) for a period of sixty (60) days, consisting of a trial period of
> thirty (30) days and a further period of thirty (30) days during which the parties can agree to
> enter into a Licence Quote; or (ii) until terminated by either party, whichever is first;

> 4.2 (d) the Licensee acknowledges that the Software may place watermarks on output …, have limited
> functionality, function for a limited period of time, or limit the functionality or time of
> functioning of any output.

So a public, judge-facing demo is outside "internal evaluation" without Bryntum's written OK. The
terms give a **60-day term** (a 30-day trial period + 30 days to agree a quote), not the 45 days
the Bryntum website states and the owner decision assumed. A trial counted from 2026-10-29 would end
its trial period around 2026-11-28 and the 60-day term around 2026-12-28, if that is how Bryntum
counts. Under 4.2(d) the npm trial package **may stop working after the trial period**: a judge
could find a broken calendar before 2026-12-15. This spike did not observe a time limit, because it
ran on day 1. Whatever Bryntum writes in M0-01 overrides this. Logged to BL-01.

**Install path matches Bryntum's own guidance.** The AI setup guidance the owner received after
registering the trial gives `@bryntum/calendar@npm:@bryntum/calendar-trial@<version>`. The wrapper
`@bryntum/calendar-react` takes the same version with no `-trial` suffix, at exact pinned versions.
That is what the spike does. For CSS import order and React patterns, it points to
<https://raw.githubusercontent.com/bryntum/skills/refs/heads/main/bryntum/SKILL.md> and
<https://bryntum.com/products/calendar/docs/>. The spike's CSS (structural `calendar.css`, one
theme, FontAwesome `fontawesome.css` + `solid.css`) follows the package's own notes. The Bryntum MCP
server and skills were not installed.

**FullCalendar.** `@fullcalendar/react/LICENSE.md`: "MIT License · Copyright (c) 2026 Adam Shaw ·
Permission is hereby granted, free of charge, to any person obtaining a copy of this software …"
(MIT; the premium scheduler plugins are separate and not used).

## Proposed `CashCalendar` interface

Both spike implementations satisfy it (`spikes/bryntum-calendar/src/cash-calendar.ts`). No vendor
type crosses it.

```ts
/** One expected release of held money, derived from a PENDING capture (M3-01). */
export type ReleaseEvent = {
  id: string;          // PayPal capture id; returned by onSelect
  date: string;        // YYYY-MM-DD, estimated release day already resolved in the workspace zone (all-day)
  amount: string;      // decimal string as PayPal returns it, never a float
  currency: string;    // ISO 4217
  label: string;       // plain text, rendered as text (never HTML)
  estimated: boolean;  // release dates are estimates; true shows the "estimated" badge
};

export type CashCalendarProps = {
  events: readonly ReleaseEvent[];
  locale: string;                       // BCP 47 from next-intl: en-IN, hi-IN
  timeZone: string;                     // IANA workspace zone (formatting; not used to shift all-day dates)
  initialDate?: string;                 // YYYY-MM-DD; default: first event's month
  onSelect?: (eventId: string) => void; // click and keyboard (Enter/Space)
  labels: { calendar: string; estimated: string }; // translated strings
  colorScheme?: "light" | "dark";
};
```

Rules the spike surfaced, for M3-05:
- Render labels as text. Bryntum inserts a string returned by `eventRenderer` as `innerHTML`. The spike
  returns `DomConfig` with `text`. FullCalendar's `eventContent` returns JSX.
- `onSelect` must work from the keyboard. FullCalendar does this. Bryntum needs a key handler on the event.
- Both libraries ship a Hindi locale (`calendar.locale.Hi.js`; `@fullcalendar/react/locales/hi`). The
  spike formats amounts with `Intl.NumberFormat(locale)` and does not load either locale (M4-03).
- The "estimated" badge has to fit at 375 px. Neither library's default month chip shows it there.
  M3-05 should put the badge in the chip's accessible name or use a list/agenda view on mobile.

## How a build would get a Bryntum token (only for a licensed build)

The trial needs **no token**: it is a public npm package. A licensed build would switch the alias to
`"@bryntum/calendar": "npm:@bryntum/calendar@7.3.8"` from Bryntum's private registry. Then:

- One env name: **`BRYNTUM_NPM_TOKEN`**. It is a Render **build** env var on `cleared-web` (set in
  the dashboard, `sync: false` in `render.yaml`) and a GitHub Actions **secret** of the same name.
- Commit only the scope line, in a project `.npmrc`: `@bryntum:registry=https://npm.bryntum.com`.
  The build step writes the auth line for `//npm.bryntum.com/` from `$BRYNTUM_NPM_TOKEN` into the
  **user-level** `~/.npmrc` of the build machine, before `pnpm install`. No tracked file ever holds
  the auth line or a token.
- Used only if Bryntum is chosen, and only for a licensed build. Nothing is set up now.

## Recommendation for M3-05

Build `CashCalendar` on **FullCalendar 7.1.3** now. It is MIT, adds 58 KiB gzip, renders 0.12 s
sooner, has no watermark, no install scripts and no licence end date, and Enter on an event works.
Keep the `CashCalendar` interface above, so the vendor sits behind one component.

Decision rule, tied to M0-01 (decision date **2026-11-04**):
- **Bryntum** only if, by 2026-11-04, Bryntum has said **in writing** that the 7.3.8 trial may run on
  the public, judge-facing demo **until 2026-12-15** (or has given a licence or hackathon key). The
  OK must also confirm that the trial build keeps working until then (4.2(d) allows a time limit). The
  watermark must be acceptable to them and to us. Then add the Bryntum adapter behind
  `CashCalendar`: no `timeZone` prop, a keyboard `onSelect`, the a11y overrides, and the two
  `allowBuilds` entries. Accept +1.5 MiB gzip on the calendar route only (dynamic import).
- **FullCalendar** in every other case (no answer, a no, an answer without "public" or without the
  date, or terms that end before 2026-12-15). The only loss is the Bryntum sponsor prize
  (`PROJECT.md` §10).

## Handoff

- **M3-05:** the interface above. Use FullCalendar unless M0-01 has a written OK. Pass dates already
  resolved, with no Bryntum `timeZone`. Fix the contrast with theme variables (FC event blue 3.69:1).
  Keyboard: FC events are tab stops and Enter works; day cells are not focusable. Token plan: the
  `BRYNTUM_NPM_TOKEN` env/secret only for a licensed build.
- **M0-01:** the watermark description and screenshot above. The packaged trial terms say "internal
  evaluation … not for any other purpose" and 30 + 30 days (the website says 45). They also say the
  software may "function for a limited period of time". So ask for a written exception that covers
  public judging until 2026-12-15, and for confirmation that the npm trial build keeps working
  until then.
- **M1-06:** neither month view is WCAG 2.2 AA clean out of the box (contrast in both; Bryntum adds
  label mismatch and an unnamed 375 px button). At 375 px both month grids cut the event labels, so
  the design system needs a mobile list/agenda pattern for the calendar.
- **M5-CLEANUP:** `spikes/bryntum-calendar/` holds no secret and no Bryntum code (the code is
  installed from npm). It can stay in the public tree as evidence, or be deleted. Its README says it
  is a trial.
