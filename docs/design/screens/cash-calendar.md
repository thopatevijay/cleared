# Screen: cash calendar

Route `/[locale]/calendar`. Built by **M3-05**. Per ADR 0016, the engine is **Bryntum Calendar only**, behind `CashCalendar` (client-only `next/dynamic`, `ssr: false`), together with an always-present accessible table of upcoming releases. M3-05 does not start until P-38 (Bryntum's written permission) is recorded.

## Purpose
Show when held money is **estimated** to free up, and when dispute replies are due, so the seller can plan cash. Seller job: "how much frees up this week, and what deadlines are coming?" Judge job: storyboard 1:50–2:15, total held money and when it frees up.

## Layout
Top to bottom:
1. h1 "Cash calendar" + the total held now, per currency ("$604.00 USD held now").
2. A view switch (segmented control, two options): **"List"** | **"Month"**. The default is List below 768 px and Month at 768 px and above. The choice persists in the URL (`?view=`).
3. The calendar (`CashCalendar`).
4. **"Upcoming releases and deadlines"**: an accessible `<table>` that is always rendered (server-rendered, so it works without JS and serves screen readers). Columns: Date | Event | Amount | Estimate source. It is visible at all widths below the calendar. In List view it is the same data, so it is collapsed into a "Show as table" disclosure to avoid duplicating content.

**Event kinds** (colours from our tokens, never Bryntum's defaults; each with an icon and a word):
| Kind | Icon | Colours (fill / text) | Label on event |
|---|---|---|---|
| `estimated_release` | `hourglass` | `status-held-bg` / `status-held-fg` + **dashed** 1.5 px `border-strong` | "$64.00 USD · estimated" |
| `dispute_deadline` | `alarm-clock` | `status-dispute-bg` / `status-dispute-fg` | "Reply due · $120.00 USD" |
| `released` | `circle-check` | `status-completed-bg` / `status-completed-fg` | "$420.00 USD released" |
| `service_completed_due` | `calendar-check` | `status-info-bg` / `status-info-fg` | "Completed + 7 days · estimated" |

**375 px: list/agenda view (required).** The M0-09 spike found that Bryntum's month grid at 375 px cuts event labels to the amount prefix and hides the "estimated" badge, so a month grid is **never** the default below 768 px. The list view (Bryntum `agenda` mode, or our own list fed the same events if agenda fails these rules) shows:
- day group headers ("Thu 5 Nov"), each with the day's total per currency ("$64.00 USD estimated")
- one 56 px+ row per event, with icon, amount (`text-lg` tabular), the kind label, "estimated" when applicable, and a "Source" disclosure. The text wraps and is never truncated
- the next 30 days by default, with "Show next 30 days" to extend it (the API caps at 92 days)
- no horizontal scroll, in EN and HI

If the user switches to Month at 375 px, day cells show only a count dot + total ("2 · $484"), and selecting a day opens that day's list below the grid. Event labels are never squeezed into cells.

**768 px:** Month by default. Event bars show the amount + "estimated" on two lines (the event height is raised so the label is never cut; if Bryntum can't fit it, the bar shows the icon + amount and the day popover lists the full label). Day cells show the per-currency totals.

**1440 px:** Month grid (max 1100 px) with a right column (340 px) listing the selected day's events in full.

**Light and dark:** our tokens are mapped onto Bryntum's CSS variables in one override file (`cash-calendar/bryntum-theme.css`). The weekend header uses `text-muted`, not Bryntum's red (4.22:1 in the spike, which fails). The trial watermark stays, as the licence requires; it is noted in the PR (M3-05).

## Components
`CashCalendar` (props: `events`, `totals`, `locale`, `tz`, `onSelect`), the view switch, `MoneyCell`, `EstimatedDate` / `Citation` (source), `StatusBadge` (held, dispute, completed, info), `EmptyState`, `LoadingState`, `ErrorPanel`.

**Rules for `BryntumCashCalendar` (fixes for every M0-09 a11y finding):**
1. **Event colours** from tokens (table above). The fill/text pairs are the status pairs checked by `design-tokens.mjs --check`. No library default colours (FullCalendar-style blue at 3.69:1 and Bryntum's red at 4.22:1 both fail).
2. **Accessible name of each event**: "{amount in words}, {kind}, estimated, {date}, source {rule source}". For example: "64.00 US dollars, estimated release, estimated, Thursday 5 November, source PayPal Help: payment review hold". Release events omit "estimated" and add "released, from PayPal".
3. **Day cells:** the `aria-label` must contain the visible text (fixes `label-content-name-mismatch`): "Thursday 5 November, 2 events, 64.00 US dollars estimated".
4. **Toolbar buttons have names at every width:** the "Today" button keeps its text label at 375 px, or gets `aria-label="Today"` if the library makes it icon-only (fixes the critical `button-name`). Previous and next carry "Previous month" / "Next month".
5. **Keyboard select:** Enter and Space on a focused event call `onSelect` (the spike found Enter didn't fire it). Add a keydown handler on the event element if the library doesn't do it. The arrow keys keep Bryntum's grid navigation.
6. **All-day dates are resolved before they reach the library.** The API returns release days as `YYYY-MM-DD` already resolved in the workspace tz. Pass them as all-day local dates and **never pass `timeZone`** to Bryntum for all-day events (the spike saw a +1-day shift).
7. No hover-only information: everything in a tooltip is also in the event's popover, the list view and the table.

## States
| State | What shows |
|---|---|
| Loading | Calendar area: a skeleton of the list (375) or the grid outline (768+), with "Loading the calendar…". The table renders server-side immediately |
| Engine loading | Bryntum loads lazily (~1.5 MiB gzip). Meanwhile the table is fully usable and the calendar area says "Loading the calendar view…". If loading fails (chunk error), the table is shown with "The calendar view couldn't load. All dates are in the table below." |
| Empty | Icon `calendar`: "No held money. When PayPal holds a payment, its estimated release appears here." Dispute deadlines still show if present |
| Success | Events + totals + table |
| Partial | Some holds without an estimate: listed under "No estimate yet" with "PayPal gives no timeline for this reason" |
| Error | `ErrorPanel` "Couldn't load the calendar", Retry, Reference |
| Offline | Last data + banner; navigation between months uses cached data only |

## Interactions
- Selecting an event (click, tap, Enter or Space) opens the hold or dispute detail.
- Selecting a day (Month at 375 px) opens the day list below.
- "Source" on any estimated event opens the rule quote, link and `retrieved_at`.
- The view switch keeps the focused date.
- Keyboard path: Skip link → view switch (List, Month) → in List: "Show next 30 days" and each event row (Enter opens), each "Source" disclosure → in Month: Today, Previous month, Next month → grid (arrow keys move between days, Tab moves into the day's events, Enter or Space selects) → "Upcoming releases and deadlines" table (row links).

## Copy
| Key | EN | HI |
|---|---|---|
| title | Cash calendar | नकदी कैलेंडर |
| heldNow | {amount} held now | अभी {amount} रोका गया |
| view.list | List | सूची |
| view.month | Month | महीना |
| kind.estimated | {amount} · estimated | {amount} · अनुमानित |
| kind.deadline | Reply due · {amount} | जवाब की आख़िरी तारीख़ · {amount} |
| kind.released | {amount} released | {amount} रिलीज़ हुआ |
| kind.completedDue | Completed + 7 days · estimated | Completed + 7 दिन · अनुमानित |
| table.caption | Upcoming releases and deadlines | आने वाली रिलीज़ और आख़िरी तारीख़ें |
| empty | No held money. When PayPal holds a payment, its estimated release appears here. | कोई पैसा रुका नहीं है। जब PayPal कोई भुगतान रोकेगा, उसकी अनुमानित रिलीज़ यहाँ दिखेगी। |
| noEstimate | PayPal gives no timeline for this reason | इस कारण के लिए PayPal कोई समय-सीमा नहीं बताता |
| engineFailed | The calendar view couldn't load. All dates are in the table below. | कैलेंडर नहीं खुल सका। सभी तारीख़ें नीचे की तालिका में हैं। |

Bryntum's built-in Hindi locale is used for month and day names in `/hi`.

## Accessibility
- The table has a `<caption>` and `scope="col"` headers. Amounts are right-aligned with tabular figures, and the date column uses `<time datetime="2026-11-05">`.
- The table, not the calendar, is the canonical accessible representation. The calendar must still pass axe with zero serious or critical violations (M3-05 AC).
- Day totals are never summed across currencies.
- 375 px: list rows ≥ 56 px, view switch options ≥ 44 px, no clipped label or "estimated" (this is the spike's failure, so `ui-reviewer` checks it explicitly).
- Reduced motion: Bryntum's view-change animations are disabled (`animateTimeShift: false` or equivalent) when `prefers-reduced-motion` is set.
