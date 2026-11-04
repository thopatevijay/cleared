# Screen: dashboard ("Your PayPal money")

Route `/[locale]/payments`. The hero screen. M1-07 builds the M1 subset; M2 and M3 tickets add rows and facts in place.

## Purpose
This screen answers the seller's question in one glance: how much money is held, what is in dispute, which payments already carry proof, and the one next step on each. For the judge, it is the self-explaining first screen after "Try as demo seller". Every number links to its reason, and every row shows PayPal's own state.

## Layout

**Wireframe elements and who delivers them.** Every element of the RESEARCH §9 hero wireframe, in order. **M1** = built in M1-07; the rest arrive later. "Adjusted" means the element ships, but changed so that it follows the rules in `CLAUDE.md` and the README copy rules.

| # | Wireframe element | Spec here | Delivered by | Milestone | Note |
|---|---|---|---|---|---|
| 1 | Title "Your PayPal money" | `<h1>` "Your PayPal money" | M1-07 | **M1** | as drawn |
| 2 | Language switch "EN \| हिं" | `LanguageSwitch` top right | M1-07 (full HI pass: M4-03) | **M1** | as drawn; the "▾" becomes two direct options, because a two-item menu adds a tap |
| 3a | Summary: "$1,304 held" | `SummaryBar` held total, per currency | M1-07 (from mirrored `PENDING` captures); M3-01 (derived holds) | **M1** | **adjusted:** shows currency codes and is never summed across currencies. The wireframe's $1,304 includes the $700 limitation (#13), which is a sample, not money held, so the demo figure is "$604.00 USD held" ($120 dispute-linked + $64 review + $420 goods) |
| 3b | Summary: "$120 in dispute" | `SummaryBar` dispute total | M2-09 | M2 | M1 shows "—" with "Arrives with dispute support" |
| 3c | Summary: "6 payments proof-ready ✓" | `SummaryBar` count of packs in state `checked` with no `missing` verdict: "6 proof packs ready"; zero: "No proof packs ready" (see [Summary zero facts](#summary-zero-facts)) | M2-05 | M2 | M1 shows "—" with "Arrives with proof packs"; the "✓" glyph becomes the `file-check` icon. **Adjusted** (owner 2026-11-04): copy says "proof packs ready", never the hyphenated "proof-ready", which broke as "proof-/ready" at 375 px |
| 4 | Dispute row: "● $120.00 Dispute: 'not as described'" | `PaymentRow` with `dispute` badge + reason "Item not as described" (`MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`) + due date | M2-09 (row data from M2-06) | M2 | as drawn, plus the PayPal status and due date |
| 5 | "[Reply ready ▸ Approve]" | Row line 3: "Reply ready" + secondary button **"Review and approve"** | M2-09 (draft from M2-07) | M2 | **adjusted:** there is no one-tap approve from the list. Approval needs the `ApprovalCard` (exact payload + draft hash), so the button opens dispute review with focus on the card |
| 6 | "Proof pack: scope ✓ delivery ✓ client sign-off ✓ (3 sources)" | Row sub-line: "Proof pack: scope met · delivery met · client sign-off met · 3 sources" | M2-05 (verdicts); client sign-off from M3-06 | M2 (sign-off M3) | **adjusted:** each "✓" becomes the verdict word + icon (`met`, `partial`, `missing`, `unverifiable`), never a bare tick |
| 7 | "● $64.00 Payment review · free ~Oct 29" | Held row: `held` badge + `PENDING_REVIEW` + `EstimatedDate` "Free by 29 Oct · estimated · Source" | M3-01 | M3 | **adjusted:** "~Oct 29" becomes "estimated" plus a Source disclosure (rule `payment_review`: up to 24 h, upper bound 3 business days). An undated "~" is not allowed |
| 8 | "[Why?]" | Secondary button "Why?" → hold detail, explanation section | M3-01 (detail), M3-02 (explanation text) | M3 | as drawn |
| 9 | "Don't ship yet" | Advice line with `triangle-alert` icon: "Don't ship yet: PayPal is reviewing this payment" + Source | M3-01 (copy rides on the `payment_review` rule row) | M3 | **conditional:** shown only if the cited rule source carries this advice. Otherwise it is omitted, since uncited advice is not allowed |
| 10 | "● $420.00 Held · needs tracking" | Held row: `held` badge + reason + "Tracking can help release this" | M3-01 + M3-03 | M3 | **adjusted:** "needs" becomes "can help", because PayPal decides the release |
| 11 | "Courier: India Post ⚠ not approved for faster release" | Route advice line: `triangle-alert` + "India Post: PayPal accepts it; it may not speed up the release. Faster: Delhivery, DTDC, Ekart, Blue Dart" + Source + caveat | M3-03 | M3 | **adjusted:** the M3-03 tier copy replaces "not approved", and the ⚠ glyph becomes an icon + text |
| 12 | "[File tracking ▸]" | Secondary button "File tracking" → hold detail, `ApprovalCard` for `add_tracking` | M3-03 | M3 | as drawn (the approval is on the detail page) |
| 13 | "○ $700.00 Account limitation" | **Not a payment row.** A link at the end of the list: "Sample scenarios: limitation, reserve, new-seller hold" with the Sandbox "Sample scenario" badge → hold inbox section | M3-01 (sample explainers) | M3 | **adjusted:** sandbox can't produce a limitation. A $700 row would be invented data and would inflate the held total |
| 14 | "[Explain]" | Inside the sample scenario explainer (hold screen) | M3-01 | M3 | moved off the dashboard with #13 |
| 15 | "[Doc pack ▸]" | — | **none** | — | **out of scope:** no ticket builds a limitation document pack (flagged to the owner; PROJECT story 8) |
| 16 | "New payment from Acme Ltd $350 → drop scope / delivery here ⬆" | A new-payment row with an empty pack: "New payment from Acme Ltd · Add proof so it's ready if PayPal asks" + secondary button **"Add proof"** → pack intake panel | M2-05 (intake panel), M2-01 (intake API) | M2 | **adjusted:** a drag-and-drop target on the dashboard is not in any ticket. "Add proof" covers the job on every device, and the drop target lives on the pack page |
| 17 | Footer "The agent does the work · you hold the keys · audit log ▸" | `<footer>`: "The agent does the work. You hold the keys." + link "Audit log" + a **Secondary** button "Sign out" (bordered, so it never reads as part of the link; its error line is `role="alert"` on its own row) | M1-07 (footer + placeholder route) | **M1** | the audit-log page itself has **no owning ticket** (flagged; see `audit-log.md`) |

Added beyond the wireframe: **"Create a sandbox test payment"** (Sandbox) in the empty state (M1-07, **M1**); the "via webhook" source tag and "Waiting for PayPal…" row (M1-07, **M1**); **"Run the dispute scenario"** (Sandbox) on demo dashboards (M2-10, M2).

**M1 subset (M1-07):** elements 1, 2, 3a, 17, with 3b/3c as "—"; the payments list (rows with amount, receivable amount, status badge with `status_details.reason` for PENDING, time, "via webhook"); the "Create a sandbox test payment" empty state; and the loading, error and waiting states.

**375 px (base):**
```
┌ header ─────────────────────────────┐
│ Cleared            [EN][हिं] [bell] │  56 px, sticky
├─────────────────────────────────────┤
│ Your PayPal money             (h1)  │
│ [hourglass] $604.00 USD held        │  one fact per line, 2xl
│ [scale] $120.00 USD in dispute      │
│ [file-check] 6 proof packs ready    │
│ [flask] Run the dispute scenario    │  demo only, Sandbox variant
├─────────────────────────────────────┤
│▌$120.00 USD     [scale] In dispute  │  PaymentRow, by attention
│▌Item not as described · due 2 Nov   │
│▌Reply ready  [Review and approve]   │
│▌Proof pack: scope met · delivery    │
│▌met · client sign-off met · 3 src   │
├─────────────────────────────────────┤
│▌$64.00 USD          [hourglass] Held│
│▌PENDING_REVIEW                      │
│▌Free by 29 Oct · estimated · Source │
│▌Don't ship yet            [Why?]    │
├─────────────────────────────────────┤
│ … more rows · Sample scenarios link │
├ footer ─────────────────────────────┤
│ The agent does the work. You hold   │
│ the keys.  Audit log                │
└─────────────────────────────────────┘
```
Rows are full width with the status rail on the left. The single row action wraps under line 3 when it doesn't fit. Nothing scrolls horizontally, and every amount, badge and "estimated" stays whole, wrapping instead of truncating (HI included).

**768 px:** content max width 720 px. The summary goes back to one line with middle dots when it fits, else two lines. Rows use the two-column grid (see `PaymentRow`).

**1440 px:** a two-pane layout. The list (max 760 px) is on the left. The right pane (min 480 px) shows the selected payment's summary (status, reason, estimated date, proof-pack verdicts) with "Open details". With nothing selected, the right pane shows "Select a payment to see its proof and status". The summary bar spans both panes at the `money` step.

**Light and dark:** both are generated from tokens. The status rail and badges keep the same hue families. No element uses an image that would need a dark variant.

### Summary zero facts
Each summary fact is a sentence, never a bare "0" (owner 2026-11-04, BL-01 6604837005 items 5/8). A fact at zero is **plain text** (icon + text, no link, no underline), because a filter that leads to an empty list is no use. Display rules:

| Fact | Value | Shows | Link? |
|---|---|---|---|
| Held (3a) | no held amounts | `dashboard.nothingHeld` "Nothing held" | no |
| Held | ≥ 1 currency | `dashboard.held` "{amount} held" | yes, to `/holds` |
| In dispute (3b) | failed to load / not built | `dashboard.inDisputeNone` "— in dispute" | no |
| In dispute | no open disputes | `disputes.dashboard.noneInDispute` "Nothing in dispute" | no |
| In dispute | ≥ 1 currency | `disputes.dashboard.inDispute` "{amount} in dispute" | yes, `?filter=dispute` |
| Proof (3c) | 0, filter not active | `dashboard.summary.proofReadyZero` "No proof packs ready" | no |
| Proof | 0, `?filter=proof-ready` active (arrived by URL) | `dashboard.summary.proofReadyZero` | yes, `aria-current="true"`; accessible name = the visible text |
| Proof | ≥ 1 | `dashboard.summary.proofReady` "6 proof packs ready" | yes, `?filter=proof-ready`; accessible name `dashboard.summary.proofReadyName` |

`proof-ready` survives only as the internal filter value in the URL (`?filter=proof-ready`); no visible or announced copy uses it. At 375 px each fact sits on its own line (22 px icon, `text-2xl` bold). "6 proof packs ready" and "No proof packs ready" are sized to fit one line at 360 px in EN and HI; if a fact does wrap, it breaks between words; never add `nowrap` (it overflowed HI at 360 px).

## Components
`LanguageSwitch`, `SummaryBar`, `PaymentRow` (with `MoneyCell`, `StatusBadge`, `EstimatedDate`, `Citation`), `SandboxBadge` + Sandbox button, `EmptyState`, `LoadingState`, `ErrorPanel`, `Toast`, and the notification bell (from `notifications.md`, M3-08). All are specified in `../components.md`.

## States
| State | What shows |
|---|---|
| Loading | Header + h1 render immediately; the summary shows three skeleton bars; there are 3 skeleton rows. After 3 s: "Loading payments from your workspace…" |
| Empty (M1) | `EmptyState`: icon `inbox`, "No payments yet", "Create a sandbox test payment and watch it arrive from PayPal through a webhook.", and the button **"Create a sandbox test payment"** with the Sandbox badge. The summary shows the three zero facts: "Nothing held", "Nothing in dispute", "No proof packs ready". After 3 per day: the button is disabled with "You've made 3 test payments today. Try again tomorrow." |
| Waiting (M1) | After the button: a row with "Waiting for PayPal…", a 16 px spinner and "Usually under 2 minutes" (live, polite). On the webhook it becomes a Completed row (flash + announcement "Payment $120.00 USD arrived from PayPal: Completed") |
| Success | Summary with figures and rows sorted by attention |
| Partial | e.g. disputes failed to load: an inline error band above the list ("Couldn't load disputes. Payments are up to date." + Retry + reference), and the dispute summary fact shows "—" |
| Error | `ErrorPanel`: "Couldn't load your payments", "Check your connection and retry.", Retry, Reference `x-correlation-id` |
| Offline | The last data stays visible; a banner reads "You're offline. Showing what was loaded at 14:02 IST." Polling pauses and resumes on `online` |
| Session expired | 401 → redirect to the landing page with "Your session ended. Sign in again or try the demo." |

## Interactions
- SWR polls `GET /api/payments` every 5 s while the tab is visible. Changed rows flash and are announced once.
- A summary fact click filters the list (`?filter=held|dispute|proof-ready`; the URL values are internal, not copy). The filter chip clears it. A fact at zero is plain text and does nothing (see Summary zero facts).
- A row click opens the payment detail (375/768) or selects it into the right pane (1440, with the URL updated, `aria-current`).
- A row action opens the target screen with focus on the relevant section ("Review and approve" → dispute review `ApprovalCard`; "Why?" → hold explanation; "File tracking" → tracking approval; "Add proof" → pack intake).
- "Create a sandbox test payment" sends `POST` with an `Idempotency-Key`. A double tap is safe, and the button shows busy as "Creating…".
- Keyboard path: Skip link "Skip to payments" → language switch (EN, हिं) → notification bell → summary facts that are links (held, in dispute, proof packs ready; a zero fact is not a Tab stop) → "Run the dispute scenario" (demo) → each payment row link, then its single row action → "Sample scenarios" link → footer "Audit log" → "Sign out". Enter activates; Escape clears an active filter when focus is in the summary.

## Copy
| Key | EN | HI |
|---|---|---|
| title | Your PayPal money | आपका PayPal पैसा |
| summary.held | {amount} held | {amount} रोका गया |
| summary.dispute | {amount} in dispute | {amount} विवाद में |
| nothingHeld | Nothing held | कुछ भी रोका नहीं गया (hold) |
| disputes.dashboard.noneInDispute | Nothing in dispute | कुछ भी विवाद में नहीं |
| summary.proofReady | {count, plural, one {# proof pack ready} other {# proof packs ready}} | {count} सबूत पैक तैयार |
| summary.proofReadyName | {count, plural, one {# proof pack ready} other {# proof packs ready}}: show only these payments | {count} सबूत पैक तैयार: सिर्फ़ ये भुगतान दिखाएँ |
| summary.proofReadyZero (new) | No proof packs ready | कोई सबूत पैक तैयार नहीं |
| filter.proofReady | Showing payments with a ready proof pack | तैयार सबूत पैक वाले भुगतान दिखाए जा रहे हैं |
| filter.none | No proof pack is ready yet. | अभी कोई सबूत पैक तैयार नहीं है। |
| summary.pending.dispute | Arrives with dispute support | विवाद सहायता के साथ आएगा |
| summary.pending.proof | Arrives with proof packs | सबूत पैक के साथ आएगा |
| row.replyReady | Reply ready | जवाब तैयार है |
| row.reviewApprove | Review and approve | देखें और मंज़ूरी दें |
| row.pack | Proof pack: scope {s} · delivery {d} · client sign-off {c} · {n} sources | सबूत पैक: तय दायरा {s} · डिलीवरी {d} · क्लाइंट की मंज़ूरी {c} · {n} स्रोत |
| row.freeBy | Free by {date} | {date} तक मिल सकता है |
| estimated | estimated | अनुमानित |
| source | Source | स्रोत |
| row.why | Why? | क्यों? |
| row.dontShip | Don't ship yet: PayPal is reviewing this payment | अभी सामान न भेजें: PayPal इस भुगतान की जाँच कर रहा है |
| row.trackingHelps | Tracking can help release this | ट्रैकिंग से यह पैसा जल्दी मिल सकता है |
| row.fileTracking | File tracking | ट्रैकिंग दर्ज करें |
| row.addProof | Add proof | सबूत जोड़ें |
| row.newPayment | New payment from {buyer}. Add proof so it's ready if PayPal asks. | {buyer} से नया भुगतान। सबूत जोड़ें, ताकि PayPal पूछे तो तैयार रहे। |
| row.viaWebhook | via webhook | webhook से |
| row.waiting | Waiting for PayPal… Usually under 2 minutes. | PayPal का इंतज़ार… आम तौर पर 2 मिनट से कम। |
| empty.title | No payments yet | अभी कोई भुगतान नहीं |
| empty.body | Create a sandbox test payment and watch it arrive from PayPal through a webhook. | सैंडबॉक्स टेस्ट भुगतान बनाएँ और देखें कि वह PayPal से webhook के ज़रिए कैसे आता है। |
| empty.cta | Create a sandbox test payment | सैंडबॉक्स टेस्ट भुगतान बनाएँ |
| scenario.cta | Run the dispute scenario | विवाद वाला परिदृश्य चलाएँ |
| samples.link | Sample scenarios: limitation, reserve, new-seller hold | नमूना स्थितियाँ: खाते पर रोक, रिज़र्व, नए विक्रेता की रोक |
| error.title | Couldn't load your payments | आपके भुगतान लोड नहीं हो सके |
| footer | The agent does the work. You hold the keys. | काम एजेंट करता है। चाबी आपके हाथ में है। |
| footer.audit | Audit log | ऑडिट लॉग |
| signOut | Sign out | साइन आउट करें |
| signOutError | Couldn't sign out. Check your connection and try again. | साइन आउट नहीं हो सका। कनेक्शन जाँचें और फिर कोशिश करें। |

Synthetic demo data: Asha Rao (logo redesign, $120.00 USD), Acme Ltd ($350.00 USD), Kofi Mensah ($64.00 USD), Ravi Traders (goods, $420.00 USD).

## Accessibility
- Landmarks: `header`, `main` (h1 "Your PayPal money"), `footer`. The list is a `<ul>` (375/768) or a `<table>` with `<caption class="sr-only">Payments, most urgent first</caption>` (1440).
- The skip link is the first Tab stop.
- One polite live region announces payment state changes and the waiting → arrived transition. It is never re-announced on unchanged polls.
- Each row's accessible name: "{amount}, {status label}, {PayPal detail}, {next step}". For example: "120.00 US dollars, In dispute, waiting for your response, reply ready, due 2 November".
- 375 px: all targets ≥ 44 px; the sticky header never covers a focused row (`scroll-margin-top: 64px`).
- HI: the summary lines wrap without clipping matras (`lineHeightHi`), and `{amount}` stays in Latin digits.
- Sorting by attention is also described in text ("Most urgent first") so the order is not conveyed only by position.
