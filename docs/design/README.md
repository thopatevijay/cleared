# Cleared design system

Owner: the `ux-designer` agent (M1-06). Builders implement these specs. The `ui-reviewer` checks the result against them using [review-checklist.md](review-checklist.md). Spec changes go through `ux-designer`, never through the builder.

The `frontend-design` skill was installed and loaded before any visual decision was made.

| File | What it holds |
|---|---|
| [tokens.json](tokens.json) | Source of truth for colour (light and dark), status, type, spacing, radius, elevation, motion, breakpoints and z-index. `node scripts/design-tokens.mjs` generates `apps/web/src/styles/tokens.css`, and `--check` verifies WCAG contrast and drift |
| [components.md](components.md) | Component specs: states, keyboard, focus and target size |
| [review-checklist.md](review-checklist.md) | What `ui-reviewer` checks on every `frontend` ticket |
| [screens/](screens/) | Hero screens: landing, dashboard, payment-detail, dispute-review, hold, cash-calendar, audit-log, notifications, client-ack, not-found |

## Users

| User | Device and context | Language | Skill | The one job |
|---|---|---|---|---|
| **Freelance or service seller** (designer, developer or translator in Bengaluru, Nairobi, Lagos, Jakarta or Manila) | Mid-range Android phone on 4G that drops to slow 3G; checks between jobs, often one-handed | EN or HI, reading English as a second language | Uses PayPal daily, has never read PayPal's hold rules | "Is my money safe, when will I get it, and what do I need to do?" |
| **Small cross-border goods seller** | Phone at the packing table, laptop for batches | EN or HI | Ships with local couriers such as India Post or Delhivery | "File tracking so the hold lifts, and tell me which courier helps" |
| **Seller facing a dispute** | Phone first, under stress, against a deadline | EN or HI | Has never answered a PayPal dispute | "Send PayPal a reply I can trust, before the deadline, without being tricked into anything" |
| **Hackathon judge** | Laptop at 1440 px, sometimes a phone; no PayPal keys and no account | EN | Expert, sceptical | Understand the product in **3 minutes**. The first screen must explain itself: what the money is, why it's held, what the agent did and what is real sandbox data |

The design is built for the first three users: small screens, slow networks, a second language and money at stake. It is checked against the fourth: someone with three minutes and no context.

## Direction: the proof slip

Cleared turns a seller's scattered chats and files into proof that PayPal accepts. The interface works like a **well-kept case file**: cool, clean paper; ink-teal for actions; amounts set large in tabular figures; every claim carrying a small source tab you can open. It should feel like a careful accountant's ledger, with no fintech gloss.

- **Palette.** Cool paper `bg #f4f6f8`, white `surface`, ink `text #18202b`, a deep **ledger teal** `accent #0a5c66` for actions and links, and a separate **focus blue** `#2348c4` so a focus ring never reads as a status. Status hues follow the Okabe–Ito colour-blind-safe set (bluish green, orange, reddish purple, vermilion, blue), always with an icon and a label. Dark mode uses slate (`#141920`), not tinted black. Teal is chosen to stay clear of PayPal's brand blue, so the UI never looks like PayPal's own.
- **Type.** **Atkinson Hyperlegible Next** for Latin: it was designed for low-vision readers and keeps 0/O and 1/l/I distinct, which matters for amounts and IDs. **Noto Sans Devanagari** for Hindi. **Atkinson Hyperlegible Mono** only for hashes, PayPal IDs and correlation IDs, never as decoration. Self-host with `next/font`, subset to Latin plus Devanagari, and use `font-display: swap`.
- **The one bold element: the money line.** The dashboard summary sets amounts at the `money` step (34 px, 700, tabular figures). Everything else stays quiet: rows instead of cards, hairline dividers, one radius per level (`sm` for chips, `md` for controls and rows, `lg` for dialogs).
- **Layout.** Left-aligned, single column at 375 px. At 768 px, the list widens and gains columns. At 1440 px, the list (max 760 px) sits beside a detail pane, and the line length stays under 75 characters.
- **Motion.** Motion only answers an action: a row expanding, a status changing (a 240 ms background flash on the changed badge), a toast entering. Nothing animates on load. `prefers-reduced-motion` sets every duration to 0 (generated in `tokens.css`).

## Principles

1. **Evidence over decoration.** Every status links to its reason: the PayPal field, the cited rule or the quoted evidence.
2. **Status is never colour alone.** Icon + label + colour, from the colour-blind-safe palette in `tokens.json`.
3. **Calm density.** One row per payment carries amount, status, reason, date and next step without visual noise.
4. **Honest copy.** We follow the claims discipline (below) and never overclaim.
5. **Live, not refresh.** SWR polls every 5 s while the tab is visible. Changes appear in place and are announced politely. A spinner always says what it is waiting for ("Waiting for PayPal…").
6. **Every state designed:** loading, empty, error, partial, success and offline.
7. **Every script the users read renders correctly.** Devanagari matras need taller lines (`lineHeightHi`). Nothing is clipped at 375 px in HI.
8. **WCAG 2.2 AA minimum:** contrast (checked by script), visible focus, keyboard paths, 44 × 44 px targets on mobile and 24 × 24 px minimum on desktop.
9. **No template look:** no gradient heroes, emoji icons, lorem ipsum, ALL-CAPS eyebrows, or arrows appended to links.

## Voice and tone

- Plain, calm and specific: the tone of a competent bookkeeper. Short sentences in the active voice and sentence case.
- Name things the way the seller does: "held money", not "capture PENDING". PayPal's exact term goes beside it as evidence (`PENDING_REVIEW`).
- A button says what it does, and the result uses the same verb: "File tracking" leads to "Tracking filed".
- Errors state what happened and the next step. They never apologise and never blame the seller.
- Second person in the product ("you keep the money"). Third person in judge-facing text such as the README and timeline ("the seller keeps the money").
- Hindi is written as natural Hindi, not word-for-word translation. PayPal terms, IDs and amounts stay in Latin script, and digits stay Latin (`numberingSystem: latn`). Hindi copy is reviewed in M4-03.

## Copy rules (claims discipline)

These are binding. `ui-reviewer` blocks on any breach.

1. **Dispute outcome.** `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL` is worded **"Resolved; you keep the money (PayPal covered the case)"** in the product and **"seller keeps the money (PayPal covered the case)"** in third person. HI: "निपटारा हुआ; पैसा आपके पास रहेगा (PayPal ने मामला कवर किया)". Never claim victory, never use the verb "w-o-n" for any outcome, and never call PayPal's decision ours. The forbidden-copy grep in the M1-06 Validation Gate runs over `docs/design`, and the dispute tickets run their own grep over `apps`.
2. **Release dates are estimates.** Every release date shows the word **"estimated"** (HI "अनुमानित") and a **source** disclosure that holds the rule's quote, link and retrieval date. Where no rule gives a date, the copy says "PayPal gives no timeline". Never promise a release, and never use wording that sounds like a guarantee.
3. **Sandbox controls are labelled.** Every sandbox-only control carries the **Sandbox** badge (flask icon). The decision control is labelled verbatim **"Simulate PayPal's decision (sandbox only)"**. Sample scenarios carry "Sample scenario: sandbox can't produce this".
4. **The agent proposes; the seller approves.** Copy never says the agent "sent", "filed" or "did" a PayPal write without an approval. Use "Drafted by the agent" and "Filed after your approval".
5. **AI accuracy.** No accuracy figure appears in the UI unless it cites the eval report with *n* (M4-02).
6. **Name the PayPal source.** A PayPal status shows its exact enum. A filed action shows PayPal's `debug_id`.
7. **No invented states.** Payment and dispute states mirror PayPal. Cleared's own states (quarantined, proposed, approved, unknown) are labelled as Cleared's.

## Numbers, currency and dates

- **Locale.** `Intl.NumberFormat` and `Intl.DateTimeFormat` with the UI locale plus the workspace region (`en-IN`, `hi-IN`; default `en-US`). Digits are always Latin.
- **Amounts.** `{ style: "currency", currency, currencyDisplay: "narrowSymbol" }`, followed by the ISO code in `text-muted` (for example "$120.00 USD"). The accessible name uses `currencyDisplay: "name"` ("120.00 US dollars"). Use tabular figures (`font-variant-numeric: tabular-nums`) and right-align amounts in tables. In `en-IN`, ₹ grouping is 1,00,000.
- **Original and receivable side by side.** If PayPal's `receivable_amount` currency differs from the capture currency, show both: "$120.00 USD · you receive ₹9,986.40 INR" (HI "आपको मिलेंगे ₹9,986.40 INR"). Never convert currencies ourselves, and never add amounts in different currencies together. Totals are listed per currency.
- **Dates.** Data is stored in UTC and displayed in the **workspace time zone** (`workspaces.tz`), with the zone abbreviation on precise times. Release days are all-day dates, resolved to `YYYY-MM-DD` in the workspace tz on the server. Format: "29 Oct" (en-IN), "29 अक्टू॰" (hi-IN). Use relative time ("4 min ago") only under 24 h, with the absolute time in `title` and the accessible name.

## Breakpoints

`sm` 375 px (the design target; layouts must also hold at 360 px, the width the Playwright specs use), `md` 768 px, `xl` 1440 px. Mobile-first: base styles target 375, and `md:`/`xl:` add to them.
