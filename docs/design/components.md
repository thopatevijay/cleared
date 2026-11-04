# Components

Every component uses tokens from `tokens.css` and no raw hex values. Icons come from **lucide-react** (outline, 1.75 stroke, 16 px inline and 20 px in rows). Decorative icons take `aria-hidden="true"`, and meaningful icons take a label. Emoji are never used as icons. Each spec covers anatomy, states, keyboard, focus and target size. File names match M1-07's deliverables where they exist.

## Shared rules

**Focus ring (all interactive elements).** Use `:focus-visible`: `outline: 2px solid var(--color-focus); outline-offset: 2px`. Rows and full-width controls use `outline-offset: -2px` so the ring is not clipped by the scroll container. On the toast (inverse surface), use `--color-focus-inverse`. The ring reaches at least 3:1 against `bg`, `surface` and `surface-sunken` in both themes (checked in `tokens.json`). Never `outline: none` without this replacement. Focused elements are never hidden under the sticky header or the toast (WCAG 2.4.11): add `scroll-margin-top` equal to the header height.

**Target size.** On mobile (< 768 px), every interactive target is at least **44 × 44 px**. Hit areas can extend past the visible element with padding or a `::before` inset. On desktop the minimum is 24 × 24 px, with 44 px still preferred for primary actions. Inline links in running text are exempt.

**Buttons.**

| Variant | Fill / text | Boundary | Use |
|---|---|---|---|
| Primary | `accent` / `on-accent`; hover and pressed `accent-hover` | itself (3:1 vs surface) | One per view: Approve, File tracking, Try as demo seller |
| Secondary | `surface` / `accent` | 1 px `border-strong` | Why?, Explain, View pack, Sign out (footer) |
| Destructive | `danger` / `on-danger` | itself | Accept claim (only after typed confirmation) |
| Sandbox | `status-sandbox-bg` / `status-sandbox-fg` | 1.5 px **dashed** `border-strong` + Sandbox badge inside | Every sandbox-only control |

States: default, hover, focus-visible, pressed, busy (inline 16 px spinner + verb in progress, for example "Approving…", with `aria-busy="true"` and the button disabled), and disabled. A disabled button uses `surface-sunken` / `text-muted` (still 4.5:1) and a visible reason below it, linked with `aria-describedby`. A disabled control always says why.

**Live updates.** A changed value briefly flashes `status-*-bg` (240 ms; none under reduced motion). The change is announced through one page-level `aria-live="polite"` region ("Payment $120.00 USD is now Held: BUYER_COMPLAINT"). Errors use `role="alert"`.

---

## Status badge (`StatusBadge`)

**Anatomy.** A pill (`radius-pill`, 24 px high, `px-2`) holding an icon (16 px, `aria-hidden`) and a label (`text-sm`, 500). The PayPal detail sits **beside** the pill in `text-muted`, never inside it: the `status_details.reason` for held, the PayPal status for dispute and failed, and the outcome for resolved. The badge is never colour alone.

| Key | Icon (lucide) | Label EN | Label HI | Colours | PayPal mapping |
|---|---|---|---|---|---|
| completed | `circle-check` | Completed | पूरा हुआ | status-completed | capture `COMPLETED` |
| held | `hourglass` | Held | रोका गया | status-held | capture `PENDING` + `status_details.reason` (shown beside it, e.g. `PENDING_REVIEW`) |
| dispute | `scale` | In dispute | विवाद में | status-dispute | dispute `OPEN`, `WAITING_FOR_SELLER_RESPONSE`, `WAITING_FOR_BUYER_RESPONSE`, `UNDER_REVIEW` |
| resolved | `flag` | Resolved | निपटारा हुआ | status-neutral | dispute `RESOLVED`; the outcome text explains it (neutral on purpose) |
| refunded | `undo-2` | Refunded | रिफ़ंड हुआ | status-neutral | capture `REFUNDED`; `PARTIALLY_REFUNDED` adds "Partly refunded $40.00 USD" beside it |
| failed | `circle-x` | Not completed | पूरा नहीं हुआ | status-error | capture `DECLINED` or `FAILED` (shown beside it) |
| quarantined | `shield-alert` | Quarantined | अलग रखा गया | status-error | Cleared's own state: no owner workspace. Tooltip: "Not created through this workspace, so Cleared won't act on it" |
| info | `info` | Info | जानकारी | status-info | No PayPal state. Used for notes and source tags such as "via webhook" |
| sandbox | `flask-conical` | Sandbox | सैंडबॉक्स | status-sandbox | `PAYPAL_ENV=sandbox` controls and data (see Sandbox badge) |

- **Static badge:** not focusable. Its accessible text is the label plus the detail ("Held, PENDING_REVIEW").
- **Linked badge** (principle 1): when the badge links to its reason, the whole pill plus detail is one `<a>`, with a hit area of at least 44 px on mobile. Enter follows the link. Focus ring as in Shared rules.
- **States:** default, changed (flash + live announcement), and loading (a `skeleton` pill 72 × 24 px).
- Sentence case. No ALL CAPS, even for PayPal enums in the pill. Enums appear beside the pill in mono at `text-xs`.

## Money cell (`MoneyCell`)

**Anatomy.** The amount (`text-lg` 600 tabular in rows; `money` step in the summary bar) followed by the ISO code (`text-xs`, `text-muted`). If the receivable currency differs, a second line reads "you receive ₹9,986.40 INR" (`text-sm`, `text-muted`). When PayPal reported the exchange rate, a third line reads `row.rate` "PayPal's rate: 1 USD = 83.2200 INR", with the rate's own digits (M4-03; display only, never used to convert).

- **Formatting:** as in README "Numbers, currency and dates". Negative values (refunds) show "−$40.00", with "refunded" in the accessible name.
- **Accessible name:** "120.00 US dollars; you receive 9,986.40 Indian rupees".
- **States:** value, unknown (`—`, with an `sr-only` reason "Not yet reported by PayPal"), and loading (skeleton 96 × 24).
- Not interactive. In tables it is right-aligned; on mobile rows it sits on the left at the start of the row.

## Payment row (`PaymentRow`)

**Anatomy, 375 px** (single column, the whole row is one link to the detail):
```
▌ $120.00 USD                          [scale] In dispute
▌ Asha Rao · Logo redesign             WAITING_FOR_SELLER_RESPONSE
▌ Reply ready · due 2 Nov, 23:59 IST   [Review and approve ›]
```
- A 4 px **status rail** (`▌`) on the left edge in the status fg colour (3:1 on the surface; decorative, the badge carries the meaning).
- Line 1: MoneyCell + StatusBadge (right-aligned; wraps under the amount if there isn't room).
- Line 2: buyer and item (synthetic in the demo) + the PayPal detail.
- Line 3: the next step or reason (time in the workspace tz, `text-sm`) + at most **one** row action (a secondary button). Other actions live on the detail page.
- Optional source tag: `info` text "via webhook" (`text-xs`).
- Optional sub-line: proof-pack summary ("Proof pack: scope, delivery, client sign-off checked · 3 sources").

**768 px:** a two-column grid: amount and buyer on the left; status, next step and action on the right. **1440 px:** a table row with columns Amount | Buyer and item | Status | Next step | Updated, plus a row action, and the selected row opens in the detail pane.

**Sort ("by attention").** Dispute with an approaching deadline (soonest first) → held with an action available → held with nothing to do → completed (newest first) → refunded/failed. Quarantined rows never appear in the list (see dashboard).

**States:** default, hover (`surface-sunken`), focus-visible (inset ring), selected (1440: 2 px `accent` left border + `aria-current="true"`), waiting ("Waiting for PayPal…" with a 16 px spinner, polite announcement, no actions), changed (flash), loading (3 skeleton rows of 88 px), and stale (`text-muted` "Updated 3 min ago" when a poll fails, plus a retry in the page banner).

**Keyboard.** The row is an `<a>` (Tab stop). The row action is a separate Tab stop **after** the row link, never nested inside it. Enter opens. No arrow-key roving: rows are a plain list (`<ul>`, or a `<table>` at xl).

**Target.** Row height ≥ 72 px; row action ≥ 44 × 44 on mobile.

## Summary bar (`SummaryBar`)

**Anatomy.** The money line, one sentence with three facts, each a link that filters the list:
`$604.00 USD held · $120.00 USD in dispute · 6 proof packs ready`
- The amounts use the `money` step at ≥ 768 px and `2xl` at 375 px. They wrap one fact per line at 375 px (no middle dots on mobile; each fact on its own line, with its icon: `hourglass`, `scale`, `file-check`).
- **Totals are per currency, never summed.** With more than one currency the amounts are joined as a list with the locale's conjunction (`Intl.ListFormat`, `type: "conjunction"`), never "+", which reads as a sum (owner 2026-11-04, BL-01 6569296578 (i)): EN "$604.00 USD and €95.00 EUR held", three: "$604.00 USD, €95.00 EUR and ₹5,000.00 INR held"; HI "$604.00 USD और €95.00 EUR". Each figure is tied to its ISO code by a no-break space, so lines break only between amounts. One helper (`formatAmountList`) builds every multi-currency total (summary bar held / in dispute, held-money inbox total).
- **Not-yet-built parts** (M1): the fact shows "—" with an `sr-only` and tooltip text "Arrives with dispute support" (in dispute; M2-09) or "Arrives with proof packs" (proof-ready; M2-05). In M1 the held total is computed from mirrored `PENDING` captures.
- **States:** loading (three skeleton bars), zero ("Nothing held · Nothing in dispute · No proof packs ready": each zero fact is plain text, not a link; rules and keys in `screens/dashboard.md` "Summary zero facts"), partial (a fact whose source failed shows "—" and "Couldn't load", with a retry), and changed (flash + polite announcement).
- **Keyboard.** Each fact is a link (Tab stop), and Enter applies the filter. The applied filter shows as a removable chip ("Showing: held", followed by a lucide `x` icon button labelled "Clear filter").
- **Heading.** The bar sits directly under `<h1>` "Your PayPal money". It is a `<p>`, not a heading.

## Citation chip (`Citation`)

Evidence over decoration: every AI claim and every rule-based estimate carries a citation.

**Anatomy (collapsed).** A chip (`radius-sm`, `surface-sunken`, `text-sm`) with a `quote` icon, the first 60 characters of the verbatim quote in quotation marks, and the source name ("Client chat, 12 Oct", "PayPal Help: help129"). **Expanded:** a disclosure panel below it showing the full quote with the cited span highlighted (`highlight`, a `<mark>`), the evidence item or URL as a link, `retrieved_at` for rules, and the evidence `sha256` short form (mono, 8 characters).

- **States:** collapsed, expanded, broken source (the evidence was deleted or the URL is unreachable: "Source unavailable" with `circle-x` and the stored quote still shown), and unverifiable (on verdicts: "No citation" or "Image only: can't quote", in `text-muted` with an `info` icon).
- **Keyboard.** The chip is a `<button aria-expanded>`. Enter or Space toggles it. Inside, the source link is the next Tab stop. Escape collapses the chip and returns focus to it.
- **Target.** ≥ 44 px high on mobile (the chip can wrap to two lines).
- **Safety.** Quotes and model output render as plain text, never HTML or markdown.

## Estimated date (`EstimatedDate`)

**Anatomy.** A calendar icon, the date ("29 Oct"), the word **estimated** (always visible, never truncated) and a **Source** disclosure (a Citation chip with the rule's quote, URL and `retrieved_at`). Example: "Free by 29 Oct · estimated · Source". HI: "29 अक्टू॰ तक मिल सकता है · अनुमानित · स्रोत".
- **Variants:** a range ("within 24 hours; up to 3 business days · estimated"), no date ("PayPal gives no timeline", plus the source), dispute-linked ("Released when the dispute is resolved · Dispute reply due 2 Nov"), and pending event ("After the courier confirms delivery · estimated").
- **Styling.** A 1.5 px dashed `border-strong` boundary on `surface-sunken`: dashed means "not yet fact". The style never changes to solid until PayPal reports the release, and then the component is replaced by a Completed badge.
- **Accessible name.** "Estimated release 29 October 2026, source PayPal Help help129".
- **Keyboard.** As for Citation (the disclosure is a button).

## Approval card (`ApprovalCard`)

The only path to a PayPal write. It shows **exactly what goes to PayPal**.

**Anatomy:**
1. Heading: the action in plain words ("Send this reply and evidence to PayPal"), with the dispute or order ID in mono.
2. **What PayPal receives:** a definition list of the payload fields, as sent: action kind (`provide_evidence`, `add_tracking`, `accept_claim`), the target ID, the notes (plain text, scrollable, with the character count "1,412 / 2000"), the evidence files (name, type, size, each < 10 MB, total ≤ 50 MB) and the compiled PDF (with a download link). For tracking: carrier code, tracking number and `notify_payer: false`.
3. **Draft hash:** "Draft fingerprint `9f3c1a7e`" (the first 8 of `payload_sha256`, mono). A button copies the full hash. Note: "Approving signs this exact draft. Any change makes a new fingerprint."
4. **Deadline:** "PayPal needs this by 2 Nov, 23:59 IST. Cleared stops filing 1 hour before." Shown as a `held`-colour countdown when under 72 h.
5. **Allowed by PayPal:** a check that the action is in the dispute's current links ("PayPal currently allows: provide evidence, accept claim"). If it isn't, the card is disabled with "PayPal doesn't allow this action right now".
6. Actions: **Approve and send** (primary) and **Edit draft** (secondary). `accept_claim` uses the Destructive variant behind a typed confirmation of the exact amount + currency ("Type 120.00 USD to confirm").
7. A confirm dialog after Approve: "This sends the reply above to PayPal. You can't withdraw it after it's sent." Buttons: "Send to PayPal" / "Go back". Initial focus goes to "Go back".

**States:** proposed, approving (busy), approved ("Approved by you, 14:02 IST"), executing ("Sending to PayPal…"), unknown ("Checking with PayPal: the reply may have been received. We'll confirm within 10 minutes." Nothing is ever resent automatically), succeeded ("Filed after your approval · PayPal debug_id `f1a2b3c4d5e6`"), failed (a localised refusal: `APPROVAL_HASH_MISMATCH` "This draft changed. Review the new version and approve again."; `DEADLINE_PASSED`; `ACTION_LINK_MISSING`; `KILL_SWITCH` "Sending is paused by the operator."; `RECONCILE_NOT_APPLIED` "PayPal didn't record the reply. You can review and approve again."), and stale (a newer draft exists: the card is replaced and the old hash is shown struck through).

**Keyboard.** Tab order: heading link → payload disclosures → evidence links → copy hash → Edit draft → Approve. The dialog traps focus, Escape cancels, and focus returns to Approve. No keyboard shortcut approves.

**Target.** Approve is full width at 375 px, 48 px high. It never sits next to the Destructive button: Accept claim lives in a separate "Other options" disclosure.

## Sandbox badge (`SandboxBadge`)

**Anatomy.** The `sandbox` status pill (`flask-conical` + "Sandbox"), placed **inside** every sandbox-only control and on every sandbox-generated card. The controls are "Create a sandbox test payment", "Run the dispute scenario" and **"Simulate PayPal's decision (sandbox only)"**. Sample scenarios use the same pill with the label "Sample scenario: sandbox can't produce this" (HI "नमूना स्थिति: सैंडबॉक्स इसे नहीं बना सकता").

- Sandbox controls use the Sandbox button variant (dashed boundary), so they never look like the primary product path.
- **Accessible name:** the control's name ends with "(sandbox only)". The pill itself is `aria-hidden` when inside a button whose name already includes it.
- **States:** inherits the button's states. When hidden (`PAYPAL_ENV` ≠ `sandbox`), the control is absent, not disabled.

## Empty, loading and error panels (`EmptyState`, `LoadingState`, `ErrorPanel`)

**Empty.** A 32 px outline icon, one-line heading, one sentence and at most one action. No illustrations. The copy invites action ("No payments yet. Create a sandbox test payment to see one arrive from PayPal.").

**Loading.** Skeletons shaped like the real content (`skeleton` colour, no shimmer under reduced motion). After 3 s, add a line saying what is awaited ("Loading payments from your workspace…"). After 10 s: "Still waiting. PayPal or our server may be slow." Never a bare spinner.

**Error (`ErrorPanel`).**
- Anatomy: `circle-x` in `status-error-fg`, a heading (`status-error-fg` on `surface`), what happened in plain words, what to do, a **Retry** button (secondary), and **"Reference: `c0r-7f2a91`"** (the correlation ID from the response header `x-correlation-id`, mono, with a Copy button). PayPal errors also show `debug_id`.
- `role="alert"` on the first render only, never on re-polls.
- Variants: network/offline ("You're offline. Showing what was loaded at 14:02."; cached content stays visible), server 5xx, not found (no correlation ID needed, but shown if present), 401 (redirect to landing), and 429 (shows `Retry-After` as "Try again in 4 minutes").
- **Partial:** an inline error band (`status-error-bg`) above the section that failed while the rest of the page stays usable.

**Keyboard.** Retry and Copy are Tab stops. After Retry, focus stays on the button while it is busy, then moves to the reloaded region's heading.

## Language switch (`LanguageSwitch`)

**Anatomy.** A two-option segmented control in the header: "EN" | "हिं". Each option has `lang` set (`lang="en"`, `lang="hi"`) and the full name for assistive tech ("English", "हिन्दी"). The current option is `aria-current="true"`, with an `accent` 2 px underline plus bold (not colour alone).
- **Behaviour.** The options are links to the same route under `/en` or `/hi` (next-intl). `<html lang>` updates. The choice persists in a cookie and the workspace locale. No reload flash: the current scroll position and filter are kept in the URL.
- **Keyboard.** Two Tab stops (links). Enter switches.
- **Target.** Each option is 44 × 44 px minimum on mobile.
- **States:** default, current, and switching (the option shows busy if the switch takes > 300 ms).

## Time zone control (`TimeZoneControl`, M4-03)

The workspace time zone is detected from the browser when the workspace is created, and the seller can change it here. Every date and deadline on every screen, and in emails and the scope snapshot, follows it (README "Dates"). The time zone is stored as an IANA name, and times stay UTC underneath.

**Placement.** On every signed-in page, in the dashboard footer, on its own line under "you hold the keys" and the audit-log link. It is not shown on the landing page or on the public acknowledgement page.

**Anatomy, closed.** One line in `text-sm` `text-muted`: `dashboard.timeZone.current` "Times shown in {zone}", where {zone} is the IANA name (for example `Asia/Kolkata`) in `tabular`, followed by a **secondary** text button, `dashboard.timeZone.change` "Change time zone" (`accent`, underlined, `min-h-11`).

**Anatomy, open.** The button is `aria-expanded="true"` and controls a region below it with:
- a label `dashboard.timeZone.label` "Time zone", over a native `<select>` of every zone in `Intl.supportedValuesOf('timeZone')` plus `UTC`, sorted by name, with the current zone selected. It is full width up to 360 px and `min-h-11`.
- a hint `dashboard.timeZone.hint` "Dates and deadlines follow this zone. Times are kept in UTC.", linked with `aria-describedby`.
- the buttons, **primary** `dashboard.timeZone.save` "Save" and **secondary** `dashboard.timeZone.cancel` "Cancel". Both are `min-h-11`. They sit side by side, and they stack at 320 px.

**Behaviour.** Save sends `PATCH /api/workspace { timezone }` with an idempotency key. While it is busy, Save reads `dashboard.timeZone.saving` "Saving…" with `aria-busy`. On success the region closes and every on-screen list re-fetches, so dates re-render in the new zone with no reload. A polite status line reads `dashboard.timeZone.saved` "Times now shown in {zone}." The same zone saved again is a no-op success.

**States:**
- loading: while the workspace is read, the line holds its height and shows no button
- closed, open, busy and saved, as above
- error: an inline `role="alert"` line, `dashboard.timeZone.error` "Couldn't save the time zone. Nothing changed. Try again.", with the region kept open and the old zone still shown
- not signed in, or the workspace failed to load: not rendered

**Keyboard and focus.** Tab reaches "Change time zone". Enter opens the region and moves focus to the select. Escape inside the region, or Cancel, closes it and returns focus to the button. After a save, focus returns to the button.

**Language.** HI copy comes from `hi.json`. The IANA name stays in Latin script (`lang="en"`, `translate="no"`), as PayPal codes do.

## Toast (`Toast`)

**Anatomy.** On `inverse-bg` / `inverse-text`, `radius-md`, `shadow-overlay`, max width 420 px, bottom-centre on mobile (above the safe area) and bottom-right on desktop. An icon, one sentence, and an optional single action ("View"). A close button (`x`, labelled "Dismiss").

- **Use** only for confirming the seller's own action ("Tracking filed", "Copied") and for background changes worth noticing ("A dispute was opened on $120.00 USD"). Errors that need action use ErrorPanel, never a toast.
- **Timing.** 6 s; paused on hover and focus; persistent if it has an action. At most one visible, and later toasts queue.
- **Announcement.** `role="status"` (polite). It never steals focus. Focus ring on its action: `focus-inverse`.
- **Keyboard.** Its controls are reachable in DOM order (rendered at the end of `<main>`); Escape dismisses while focus is inside. It never covers the focused element (WCAG 2.4.11).
- **Motion.** 150 ms fade + 8 px rise; none under reduced motion.

## Audit log row (`AuditRow`)

**Anatomy:** time (workspace tz, absolute, `text-sm` tabular), actor (icon + label: `user` "You", `bot` "Agent", `server` "Cleared", `flask-conical` "Sandbox decision"), the action in plain words ("Approved reply to dispute PP-D-27153"), the target link, the result (a status badge, or "Refused: DEADLINE_PASSED"), and evidence IDs: PayPal `debug_id`, the draft fingerprint, and the correlation ID (mono, `text-xs`, copyable).

- **375 px:** three lines (time + actor / action / IDs); the IDs line wraps and never truncates a hash below 8 characters.
- **1440 px:** a table row with columns Time | Actor | Action | Result | References.
- **States:** default, expanded (a disclosure showing the full `detail` JSON fields as a definition list; never raw model text as HTML), sandbox (the actor "Sandbox decision" and the Sandbox badge when `detail.sandbox_decision = true`), and loading (skeleton rows).
- Read only. Append-only data: there is no edit or delete affordance anywhere.
- **Keyboard.** The row's disclosure button is a Tab stop. Enter or Space toggles it. Copy buttons inside are Tab stops.
