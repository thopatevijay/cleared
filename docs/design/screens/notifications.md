# Screen: notifications (bell + centre)

The header bell on every signed-in page, a panel (≥ 768 px), and the route `/[locale]/notifications` (< 768 px, and the "See all" target). Built by **M3-08**, on its `GET/PATCH /api/notifications` API. Emails are sent only to `EMAIL_RECIPIENT_ALLOWLIST` addresses; demo workspaces are in-app only.

## Purpose
Tell the seller, without them checking, when money is held, a dispute opens, or a dispute deadline is 72 h or 24 h away, and take them straight to the screen where they act. Seller job: "don't let me miss a deadline." Judge job: see deadline awareness without waiting for an email.

## Layout
**Bell (header):** a `bell` icon button, 44 × 44 px, with an unread count badge (`status-dispute` colours, a pill with a number, "9+" above 9). The accessible name is "Notifications, 2 unread". With nothing unread, there is no badge and the name is "Notifications".

**Notification item:** an icon + kind word, one sentence, a time, and the link target:
| Kind | Icon | Status family | EN example |
|---|---|---|---|
| `hold_opened` | `hourglass` | held | "PayPal is holding $64.00 USD from Kofi Mensah (PENDING_REVIEW)." |
| `dispute_opened` | `scale` | dispute | "Asha Rao opened a dispute on $120.00 USD: item not as described. A reply is being drafted." |
| `deadline_t72` | `alarm-clock` | held | "Reply to the $120.00 USD dispute is due in 3 days (2 Nov, 23:59 IST)." |
| `deadline_t24` | `alarm-clock` | dispute | "Reply to the $120.00 USD dispute is due in 18 hours (2 Nov, 23:59 IST)." (a late run states the true remaining time) |
| `completed_reminder` | `calendar-check` | info | "7 days since you marked the order Completed. The estimated release for $350.00 USD is today." |

Unread items have a 4 px `accent` left rail **and** the bold word "New" (not colour alone). Read items have no rail.

**375 px:** the bell opens the full page `/notifications` (not a popover). h1 "Notifications", then "Mark all as read" (secondary, 44 px), then the items as a list. Each item is a full-width link (≥ 64 px) with a separate "Mark as read" icon button (44 px, labelled "Mark as read: {sentence}"). Sentences wrap. Nothing truncates.

**768 px:** the bell opens a panel (popover, 380 px wide, max height 70vh, scrollable) anchored to the bell, with the latest 10 items, "Mark all as read" and "See all".

**1440 px:** the same panel. The `/notifications` page uses a 720 px column.

**Light and dark:** the panel uses `surface` + `shadow-overlay`; its dark shadow adds a 1 px light ring so it separates from the page.

## Components
Bell button, count pill, notification item, `StatusBadge` families (held, dispute, info), `EmptyState`, `LoadingState`, `ErrorPanel`, `Toast` (none: notifications don't toast on top of themselves, except a new `deadline_t24` while the seller is on another page, which toasts once with "View").

## States
| State | What shows |
|---|---|
| Loading | Panel/page: 3 skeleton items; the bell shows no count until it loads |
| Empty | Icon `bell`: "No notifications. We'll tell you here when PayPal holds money or a dispute needs a reply." |
| Success | Items newest first; unread on top within the same day |
| Partial | Mark-read fails: the item stays unread with an inline "Couldn't mark as read. Retry" |
| Error | `ErrorPanel` (inside the panel, compact): "Couldn't load notifications", Retry, Reference. The bell keeps its last count |
| Offline | Last list shown; mark-read disabled with "You're offline" |
| Email blocked or down | Not shown to the seller as an error: the in-app item is the record. A small line in the item detail reads "Email not sent" only when the workspace has an email and sending failed after retries |

## Interactions
- SWR polls the count every 5 s. When the count rises, the announcement (polite) is "1 new notification: dispute reply due in 18 hours".
- Selecting an item opens its target (hold or dispute) and marks it read.
- "Mark all as read" → PATCH; the count goes to 0 with a toast "All notifications marked as read".
- The panel (768+) is a non-modal popover: Escape closes it and returns focus to the bell, and clicking outside closes it.
- Keyboard path: Tab to the bell → Enter opens the panel (focus moves to its heading) → "Mark all as read" → each item link, then its "Mark as read" button → "See all" → Escape returns focus to the bell. At 375 px: bell → the `/notifications` page h1 → "Mark all as read" → items as above.

## Copy
| Key | EN | HI |
|---|---|---|
| bell | Notifications, {count} unread | सूचनाएँ, {count} अपठित |
| title | Notifications | सूचनाएँ |
| new | New | नई |
| markAll | Mark all as read | सभी को पढ़ा हुआ मानें |
| markOne | Mark as read | पढ़ा हुआ मानें |
| holdOpened | PayPal is holding {amount} from {buyer} ({reason}). | PayPal ने {buyer} का {amount} रोका है ({reason})। |
| disputeOpened | {buyer} opened a dispute on {amount}: {reason}. A reply is being drafted. | {buyer} ने {amount} पर विवाद खोला है: {reason}। जवाब तैयार किया जा रहा है। |
| t72 | Reply to the {amount} dispute is due in {days} days ({date}, {time} {tz}). | {amount} वाले विवाद का जवाब {days} दिन में देना है ({date}, {time} {tz})। |
| t24 | Reply to the {amount} dispute is due in {hours} hours ({date}, {time} {tz}). | {amount} वाले विवाद का जवाब {hours} घंटे में देना है ({date}, {time} {tz})। |
| empty | No notifications. We'll tell you here when PayPal holds money or a dispute needs a reply. | कोई सूचना नहीं। जब PayPal पैसा रोकेगा या किसी विवाद में जवाब चाहिए होगा, हम यहाँ बताएँगे। |
| seeAll | See all | सभी देखें |

Email subject lines follow the same sentences (M3-08 templates). Emails carry the amount, reason or deadline and a link, never evidence text or buyer messages.

## Accessibility
- The bell is a `<button aria-haspopup="dialog" aria-expanded>`; the panel is `role="dialog"` (non-modal) with the heading "Notifications".
- The count is in the bell's accessible name, not only in the visual pill.
- Unread is shown by rail + "New" word + `aria-label` prefix "New:".
- 375 px: every target ≥ 44 px; the page replaces the popover so nothing overflows the viewport.
- Announcements are polite, at most one per poll, and never repeated for the same item.
