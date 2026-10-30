# Screen: audit log

Route `/[locale]/audit`. **Ownership gap:** M1-07 ships only the footer link and a placeholder route. M2-08 writes the append-only `audit_log` data, and M2-09 shows a per-dispute audit trail panel (with `AuditRow`). **No ticket builds this workspace-wide page.** It is flagged to the owner; the proposed fix is to add it to M2-09's scope or create a small M3 ticket. The storyboard (1:50–2:15) and M3-GATE ("the audit log shows every proposal, approval and execution") depend on it.

**Placeholder (M1-07):** h1 "Audit log" and the `EmptyState` "The audit log fills in as the agent proposes actions and you approve them. Arrives with dispute support." No fake rows.

## Purpose
Prove "the agent does the work; you hold the keys": every agent proposal, every seller approval or rejection, every pre-send check, every PayPal call (with PayPal's `debug_id`) and every sandbox decision, in order, unalterable. Seller job: "what was sent in my name, and when?" Judge job: see that nothing reached PayPal without an approval.

## Layout
- h1 "Audit log" + one line: "Every action on your workspace, oldest entries kept. Nothing here can be edited or deleted."
- Filters (a `<form>`, applied on change): Actor (All, You, Agent, Cleared, Sandbox decision) and Kind (All, Disputes, Tracking, Sign-in, Sandbox), plus a free-text search on IDs (dispute ID, `debug_id`, fingerprint).
- Entries grouped by day (h2 "Fri 30 Oct"), newest first, as `AuditRow`s. "Load older" pagination (50 per page).

**375 px:** filters collapse into a "Filter" button (44 px) that opens a sheet, with chips showing the active filters. Each `AuditRow` is three lines (time + actor / action + result / references). IDs wrap and are never cut below 8 characters. A copy button sits beside each ID.

**768 px:** filters inline in one row; `AuditRow` in two lines.

**1440 px:** a `<table>`: Time | Actor | Action | Result | References. An expanded row shows the detail fields in a definition list beneath it.

**Light and dark:** from tokens. The actor icons and labels carry the meaning.

## Components
`AuditRow`, `StatusBadge` (completed, failed, sandbox, quarantined for refused-ownership entries, info), `SandboxBadge`, `EmptyState`, `LoadingState`, `ErrorPanel`.

Sample sequence for one dispute reply (synthetic IDs):
| Time (IST) | Actor | Action | Result | References |
|---|---|---|---|---|
| 14:01:12 | Agent | Proposed reply to dispute PP-D-27153 | Proposed | fingerprint `9f3c1a7e` |
| 14:02:40 | You | Approved reply | Approved | fingerprint `9f3c1a7e` |
| 14:02:41 | Cleared | Checked: owner, PayPal link, deadline | Passed | correlation `c0r-7f2a91` |
| 14:02:43 | Cleared | Sent evidence to PayPal | Completed (200) | debug_id `f1a2b3c4d5e6` |
| 14:31:05 | Sandbox decision | Simulate PayPal's decision (sandbox only) | Sent to sandbox | debug_id `a9b8c7d6e5f4` |
| 14:31:40 | Cleared | Mirrored PayPal outcome | Resolved: RESOLVED_WITH_PAYOUT | dispute PP-D-27153 |

## States
| State | What shows |
|---|---|
| Loading | 5 skeleton rows; after 3 s "Loading the audit log…" |
| Empty | Icon `scroll-text`: "Nothing yet. Every proposal, approval and PayPal call will be recorded here." |
| Filtered empty | "No entries match these filters." + "Clear filters" |
| Success | Rows grouped by day |
| Partial | "Load older" fails: an inline error under the list with Retry + Reference; loaded rows stay |
| Error | `ErrorPanel` "Couldn't load the audit log", Retry, Reference |
| Live | New entries arrive at the top (SWR 5 s) with the announcement "New audit entry: Approved reply". The scroll position is kept |

## Interactions
- Expanding a row shows its `detail` fields (plain text, never HTML). It never shows evidence text or buyer messages.
- Selecting a dispute ID or payment link opens that screen.
- Copy buttons copy the full ID and give the toast "Copied".
- There is no edit, delete or export of single rows (append-only).
- Keyboard path: Skip link → Actor filter → Kind filter → ID search → each day group's rows (disclosure button, then its links and copy buttons) → "Load older".

## Copy
| Key | EN | HI |
|---|---|---|
| title | Audit log | ऑडिट लॉग |
| intro | Every action on your workspace, oldest entries kept. Nothing here can be edited or deleted. | आपके वर्कस्पेस का हर काम, पुरानी प्रविष्टियाँ भी। यहाँ कुछ भी बदला या हटाया नहीं जा सकता। |
| actor.you | You | आप |
| actor.agent | Agent | एजेंट |
| actor.system | Cleared | Cleared |
| actor.sandbox | Sandbox decision | सैंडबॉक्स निर्णय |
| action.proposed | Proposed {action} | {action} का प्रस्ताव |
| action.approved | Approved {action} | {action} को मंज़ूरी दी |
| action.sent | Sent {action} to PayPal | {action} PayPal को भेजा |
| action.refused | Refused: {code} | रोका गया: {code} |
| empty | Nothing yet. Every proposal, approval and PayPal call will be recorded here. | अभी कुछ नहीं। हर प्रस्ताव, मंज़ूरी और PayPal कॉल यहाँ दर्ज होगी। |
| placeholder | The audit log fills in as the agent proposes actions and you approve them. Arrives with dispute support. | जैसे-जैसे एजेंट प्रस्ताव देगा और आप मंज़ूरी देंगे, ऑडिट लॉग भरता जाएगा। विवाद सहायता के साथ आएगा। |

## Accessibility
- h1, then h2 per day group. Rows are a `<ul>` (375/768) or a `<table>` with a caption (1440).
- Each actor is icon + word; the "Agent" and "You" entries are never told apart only by colour.
- Times are absolute with seconds and tz, inside `<time datetime>`.
- 375 px: the filter button, disclosure buttons and copy buttons are ≥ 44 px; IDs use mono and `overflow-wrap: anywhere`.
- New-entry announcements are polite and batched (at most one per poll: "3 new audit entries").
