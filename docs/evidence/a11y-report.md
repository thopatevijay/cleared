# Accessibility report (M4-04): WCAG 2.2 AA, measured

Ticket: M4-04 (#48). Build: local production build (`next build` + `next start`) on the msw PayPal stub
and the recorded OpenAI answers. Data: synthetic (seeded through the same repos the product writes).
Every check below is a test in `apps/web/e2e/` that anyone can re-run:

```bash
pnpm --filter @cleared/web build
pnpm --filter @cleared/web exec playwright test e2e/a11y.spec.ts e2e/keyboard-judge-path.spec.ts \
  e2e/target-size.spec.ts e2e/reflow.spec.ts e2e/cash-calendar.spec.ts
```

## 1. What is checked, and how

| WCAG 2.2 | Check | Where | Result |
|---|---|---|---|
| All A/AA rules axe covers (wcag2a, wcag2aa, wcag21aa, wcag22aa) | axe on every route × {en, hi} × {populated, empty, loading, error} | `a11y.spec.ts` | **0 serious, 0 critical** (§2) |
| 1.4.3 / 1.4.11 contrast, light and dark | every text and UI token pair in `docs/design/tokens.json`, both themes | `scripts/design-tokens.mjs --check` (landing checks) + axe `color-contrast` in light (375 px) and dark (1280 px) | pass |
| 1.4.10 reflow | no horizontal scroll at 320 CSS px (400 % of 1280) and at 640 CSS px (200 % zoom of 1280), every route, EN and HI | `reflow.spec.ts` | pass |
| 2.1.1 keyboard, 2.4.7 focus visible | the judge path end to end with Tab, Shift+Tab, Enter and Space only (no click, no navigation by URL), at 1280 and 375 px; every Tab stop asserts `:focus-visible` and a ≥ 2 px outline or a ring | `keyboard-judge-path.spec.ts` | pass |
| 2.4.11 focus not obscured (minimum) | at every Tab stop of that path, the focused element is on top at one of five points inside it (the sticky header or a fixed bar would be on top instead) | `keyboard-judge-path.spec.ts` (`support/keyboard.ts`) | pass |
| 2.5.7 dragging movements | the calendar is read-only: a drag of an event bar moves nothing; months by Previous / Next / Today, a day by its day number with Enter, a range by "Show next 30 days", an event by Enter / Space | `cash-calendar.spec.ts` "2.5.7 …" | pass |
| 2.5.8 target size (minimum) | every visible interactive element ≥ 24 × 24 CSS px (inline text links exempt; a form control's target includes its `<label>`), every route, EN at 320 and 1280 px, HI at 320 px | `target-size.spec.ts` | pass |
| 3.3.7 redundant entry | recorded pass (§4) | manual | pass |
| 3.3.8 accessible authentication (minimum) | sign-in is a magic link: one email field with `autocomplete="email"`, paste allowed, no password, no puzzle, no challenge frame | `a11y.spec.ts` "3.3.8 …" | pass |
| 4.1.3 status messages | the pack check banner, the filing status (proposed → "Sending" announced by the page's poll) and the scenario step in progress with its wait for PayPal are live regions present before their text changes | `a11y.spec.ts` "status messages …" | pass |
| 2.3.3 / `prefers-reduced-motion` | with `reduce`, no CSS animation is running on any signed-in screen, loaded or loading (skeleton pulse, spinners, row flash) | `a11y.spec.ts` "prefers-reduced-motion …" | pass |

## 2. The axe matrix

`a11y.spec.ts` writes each run's rows to `.review/M4-04/a11y/*.json` (local, gitignored). Populated
screens run axe twice (375 px light, 1280 px dark); the other states once (1280 px light). Each cell is
the number of serious + critical violations.

| Route | en populated | en empty | en loading | en error | hi populated | hi empty | hi loading | hi error |
|---|---|---|---|---|---|---|---|---|
| Landing + sign-in `/` | 0 | n/a | 0 (demo pending) | 0 (demo failed) | 0 | n/a | 0 | 0 |
| Sign-in link expired | 0 | n/a | n/a | n/a | 0 | n/a | n/a | n/a |
| Dashboard `/payments` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Payment → proof pack | 0 | 0 (no evidence) | 0 | 0 | 0 | 0 | 0 | 0 |
| Held money `/holds` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Hold detail | 0 | n/a | 0 | 0 | 0 | n/a | 0 | 0 |
| Disputes `/disputes` | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Dispute review | 0 | n/a | 0 | 0 | 0 | n/a | 0 | 0 |
| Scenario | 0 | n/a | 0 | 0 | 0 | n/a | 0 | 0 |
| Cash calendar | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Audit log | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Notifications | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Settings (footer time-zone control) | 0 (open) | n/a | 0 (saving) | 0 (save failed) | 0 | n/a | 0 | 0 |
| Client acknowledgement (no session) | 0 | n/a | 0 (confirm pending) | 0 (unusable link) | 0 | n/a | 0 | 0 |

States a screen does not have are not invented (`NOT_APPLICABLE` in the spec):

- hold detail, dispute review, scenario, empty: the page always has its record; an unknown id is the
  error state
- settings, empty: the control always shows the workspace's zone
- landing, empty: a static page
- sign-in link expired: it is itself an error page with no request after it loads
- client acknowledgement, empty: a link always carries its scope; an unusable link is the error state

There is no separate settings page: the workspace settings are the footer's time-zone control and the
header's language switch (M4-03).

## 3. Findings fixed in this ticket

| # | Finding (how it was found) | WCAG | Fix |
|---|---|---|---|
| F1 | Notifications loading: the skeleton `<ul role="status">` lost its list role, so its three `<li>` were orphaned (axe `listitem`, **serious**, EN and HI) | 1.3.1 | the live region is a `<div role="status">` with the label; the skeleton list is `aria-hidden` (`NotificationList.tsx`) |
| F2 | "स्रोत" (Source) buttons were 21 px wide in Hindi, on the dashboard, held money and hold detail (target-size spec, HI at 320 px) | 2.5.8 | `min-w-11` on the source disclosure button (`RuleSource.tsx`) |
| F3 | Dispute review below 1280 px: Shift+Tab back up the page put a field under the sticky "Reply due" band (keyboard spec at 375 px) | 2.4.11 | below `xl`, focusable elements keep 128 px clear of the top when the page has a sticky band (`globals.css`, `data-sticky-band`); `select`, `textarea` and `summary` now get the 64 px header margin too |
| F4 | Cash calendar: after Previous / Next month, the outgoing month's day numbers and event bars stayed in the tab order off-screen (x = −586 px) during the slide (keyboard spec at 1280 px) | 2.4.7, 2.4.11 | `animateTimeShift: false`: the month changes in place (`cash-calendar/bryntum.tsx`) |
| F5 | Scenario: the step in progress and its "Waiting for PayPal…" line changed without being announced | 4.1.3 | a polite live region states the active step and its wait (`ScenarioTimeline.tsx`, `data-testid="scenario-live"`) |

Minor findings: after F1, axe reports no violation of any impact (serious, critical, moderate or minor)
in any cell of the matrix, so none was logged to BL-01.

## 4. Recorded manual checks

**3.3.7 redundant entry** (2026-11-03, judge path): no step asks for information the seller already gave
in the same process. The time-zone control opens on the current zone; the client acknowledgement asks
for a name once; evidence intake keeps the chosen kind between items; the dispute reply is drafted from
the pack, not retyped.

## 5. Screen-reader pass (VoiceOver): owner step P-54

Not yet run: this is the owner's manual step (P-54, `docs/PREREQS.md`). Run it on the hosted demo, in
**macOS Safari** (VoiceOver: Cmd+F5) and **iOS Safari** (Settings → Accessibility → VoiceOver), in
English, then repeat steps 1, 3 and 6 in Hindi. Mark each line **pass / fail + what was heard**.

| # | Step (judge path) | What VoiceOver must say | macOS | iOS |
|---|---|---|---|---|
| 1 | Landing: VO+Right from the top | "Skip to main content, link", the h1, then "Try as demo seller, button" | | |
| 2 | Activate "Try as demo seller" | the button reports busy, then the dashboard h1 "Payments" is read | | |
| 3 | Dashboard rotor → Headings | Payments (h1) and the section headings in order; each payment row is a link named by its amount and status | | |
| 4 | Create a sandbox test payment | "Waiting for PayPal…" then, when the webhook lands, the new row is announced once (polite) | | |
| 5 | Open the proof pack | the banner ("Checked … 1 met, 1 partly met, 1 missing") is read; each verdict row reads its line, verdict word and citation | | |
| 6 | Held money → a hold | "Held: $64.00 USD" h1; the estimated release date and its "Source" button (named with the source title) | | |
| 7 | Source button, VO+Space | expanded state is announced; the quote is read as a quotation | | |
| 8 | Cash calendar, Month view | "Previous month / Next month, button"; the month title change is announced; events read as "Reply due · $120.00 USD …" | | |
| 9 | Dispute review → Approve | the dialog's title and body are read; focus starts on "Go back"; VO+Escape closes it and focus returns to "Approve" | | |
| 10 | Approve and send (sandbox) | "Sending", then the filed state, announced without moving focus | | |
| 11 | Notifications bell | "Notifications, n unread, button"; the panel opens on its heading | | |
| 12 | Language switch → हिन्दी | the page is read in Hindi (`lang="hi"`); PayPal codes and the wordmark in English | | |

Result: _to be filled by the owner_ (date, device, OS and Safari versions).
