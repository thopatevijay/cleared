# Screen: payment detail and proof pack

Route `/[locale]/payments/[paymentId]/pack` (`/payments/[paymentId]` redirects to it). Built by **M2-05**, on the M2-01 intake API, M2-03 facts and M2-04 verdicts. Later tickets add to it: client acknowledgement (M3-06), scope snapshot PDF (M3-07), and hold and dispute links (M3-01, M2-09).

## Purpose
Show one payment exactly as PayPal reports it, and the **proof pack** behind it: what the seller agreed to do (scope), what was delivered, and whether delivery meets scope, with every verdict citing a verbatim quote from the evidence. Seller job: "add my chat and files once, and know they'll hold up if PayPal asks." Judge job: see that AI claims are cited and checkable.

## Layout
Sections, in order:
1. **Payment header:** `MoneyCell` (amount + receivable), `StatusBadge` + PayPal detail, buyer and item (synthetic), capture ID and order ID (mono, copyable), captured time (workspace tz), source tag "via webhook". If held or in dispute: a link band "Held: BUYER_COMPLAINT · see the dispute" → hold or dispute screen.
2. **Pack state banner** (one line, icon + text, `aria-live="polite"`): collecting / checking / checked / stale / AI unavailable / budget reached (copy below).
3. **Verdicts:** one row per scope line: the scope line in the seller's words, the verdict (`met` `circle-check`, `partial` `circle-dashed`, `missing` `circle-x`, `unverifiable` `circle-help`, each as icon + word, using the completed / held / error / neutral colour families), and the `Citation` chips (quote highlighted in context, linked to its evidence item). `unverifiable` shows its reason ("No citation found", "Image only: can't quote it").
4. **Facts** grouped by type (agreed price, deadline, deliverables, sent, opened, accepted), each with its citation. "Sent", "opened" and "accepted" are separate rows, never merged.
5. **Evidence:** the intake panel (upload + paste chat with a kind selector: scope, delivery, acceptance, shipment, other) and the evidence list (kind, filename or first line, added time, `sha256` short form, a download link, and the injection-flag badge where set: `info` style, `shield-alert` icon, "Contains text that looks like instructions; treated as data").

**375 px:** a single column. Header facts stack; IDs wrap (never truncated below 8 characters, with a copy button for the full value). Verdict rows put the scope line on top and the verdict + citations below. Citation chips are full width and expand in place. The intake panel is collapsed behind a full-width secondary button "Add evidence" (48 px), and expands to: file picker button (44 px), a textarea for pasted chat (min 6 rows), a kind `<select>` and "Add". The section order puts verdicts before evidence, because the seller wants the answer first.

**768 px:** max width 720 px. Verdict rows in two columns (scope line | verdict + citations). The intake panel is open by default, with a drop zone for files ("Drop files here or choose files": jpg, png, gif, pdf, under 10 MB each).

**1440 px:** two columns. Left (8/12): header, banner, verdicts and facts. Right (4/12, sticky): evidence intake and the list. Selecting a citation scrolls the matching evidence item into view and outlines it with `accent` for 2 s (no motion under reduced motion).

**Light and dark:** `<mark>` uses `highlight` with `text` (≥ 4.5:1 in both).

## Components
`MoneyCell`, `StatusBadge`, `Citation`, `EstimatedDate` (in the hold link band), `EmptyState`, `LoadingState`, `ErrorPanel`, `Toast` ("Evidence added"), and the `SandboxBadge` on seeded demo evidence ("Synthetic demo evidence").

## States
| State | What shows |
|---|---|
| Loading | The header skeleton plus 3 verdict skeleton rows; after 3 s, "Loading the proof pack…" |
| Empty pack | `EmptyState`: icon `file-plus`, "No proof yet", "Paste the client chat where you agreed the work, and add what you delivered. Cleared checks one against the other and cites every line.", action "Add evidence" |
| Collecting | Banner `info`: "Evidence added. Add the delivery too, then Cleared checks it." |
| Checking | Banner with a 16 px spinner: "Checking delivery against scope… usually under a minute." (polls every 5 s) |
| Checked (success) | Banner `completed`: "Checked {time}. {met} met, {partial} partial, {missing} missing." with verdict rows |
| Stale | Banner `held`: "New evidence: re-checking." Old verdicts stay visible in `text-muted`, labelled "From the previous check" |
| AI unavailable (partial) | Banner `info`: "AI is unavailable: facts shown without a verdict." Facts and evidence render, and verdicts show "—" |
| Budget reached (partial) | Banner `info`: "This workspace has used its AI budget. Facts and evidence are kept; no new verdicts." |
| Upload rejected | A field error naming the server's typed code in words, e.g. `EVIDENCE_TOO_LARGE` → "This file is 11.2 MB. Files must be under 10 MB." or `EVIDENCE_TYPE` → "Only JPG, PNG, GIF and PDF files can be added." Nothing is added |
| Error | `ErrorPanel` "Couldn't load this payment", Retry, Reference |
| Not found / foreign | The not-found page: "This payment isn't in your workspace." (no detail leaks) |
| Offline | Last data shown; intake disabled with "You're offline. Evidence can be added when you reconnect." |

## Interactions
- Add evidence: client-side pre-checks (type, < 10 MB) first, then the server decides. On success, a toast "Evidence added", the list updates, and the banner moves to collecting or checking.
- A citation chip expands to the full quote in context. "Open in evidence" scrolls to and focuses the evidence item.
- Verdicts never update silently: a change announces "Verdicts updated: 3 met, 1 partial."
- All model output (facts, verdict reasons, quotes) renders as plain text.
- Keyboard path: Skip link → back link "Your PayPal money" → copy capture ID → hold/dispute link (if any) → each verdict row's citation chips (Enter expands; Tab into "Open in evidence"; Escape collapses) → facts citations → "Add evidence" → file chooser → kind select → chat textarea → "Add" → evidence list download links.

## Copy
| Key | EN | HI |
|---|---|---|
| verdict.met | Met | पूरा |
| verdict.partial | Partly met | आंशिक रूप से पूरा |
| verdict.missing | Missing | नहीं मिला |
| verdict.unverifiable | Can't verify | पुष्टि नहीं हो सकी |
| unverifiable.noCitation | No citation found | कोई उद्धरण नहीं मिला |
| unverifiable.imageOnly | Image only: can't quote it | सिर्फ़ तस्वीर है: उद्धरण नहीं दिया जा सकता |
| banner.checking | Checking delivery against scope… usually under a minute. | काम के दायरे से डिलीवरी की जाँच हो रही है… आम तौर पर एक मिनट से कम। |
| banner.checked | Checked {time}. {met} met, {partial} partly met, {missing} missing. | {time} पर जाँचा गया। {met} पूरे, {partial} आंशिक, {missing} नहीं मिले। |
| banner.stale | New evidence: re-checking. | नया सबूत: फिर से जाँच हो रही है। |
| banner.aiDown | AI is unavailable: facts shown without a verdict. | AI उपलब्ध नहीं है: तथ्य बिना नतीजे के दिखाए गए हैं। |
| empty.title | No proof yet | अभी कोई सबूत नहीं |
| empty.body | Paste the client chat where you agreed the work, and add what you delivered. Cleared checks one against the other and cites every line. | जिस चैट में काम तय हुआ था उसे पेस्ट करें, और जो आपने दिया वह जोड़ें। Cleared दोनों को मिलाकर जाँचता है और हर बात का स्रोत बताता है। |
| injection | Contains text that looks like instructions; treated as data | इसमें निर्देश जैसा पाठ है; इसे सिर्फ़ डेटा माना गया है |
| tooLarge | This file is {size}. Files must be under 10 MB. | यह फ़ाइल {size} की है। फ़ाइल 10 MB से छोटी होनी चाहिए। |

Example data (synthetic): scope line "Three logo concepts and two rounds of revisions" → Met, citing the client chat "Can you do 3 concepts + 2 revision rounds for $120?" (Asha Rao, 12 Oct) and the delivery PDF "Final logo, revision 2 of 2".

## Accessibility
- Headings: h1 "Payment from {buyer}", then h2 "Proof check", "Facts", "Evidence".
- Verdict rows are a `<ul>`. Each row's accessible name: "{scope line}: {verdict}, {n} citations".
- `<mark>` has a visually hidden prefix "quoted:", so the highlight is not conveyed only by colour.
- The drop zone is an enhancement; the file input button is always present and labelled.
- 375 px: every chip, button and select ≥ 44 px; the textarea is labelled "Paste the chat" with a hint "Paste text only. Links in it are not opened."
- HI: verdict words wrap without clipping; quotes stay in their original language, with `lang` set when known.
