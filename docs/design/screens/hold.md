# Screen: held money (inbox and hold detail)

Routes `/[locale]/holds` (inbox) and `/[locale]/holds/[holdId]` (detail). Built by **M3-01** (inbox, detail, estimated release, sample scenarios). It is extended by **M3-02** (explanation text, EN/HI), **M3-03** (tracking action, carrier tiers, route advice) and **M3-04** (guided Completed step).

## Purpose
Explain, in the seller's language, why PayPal is holding a payment, what PayPal is doing, an **estimated** release with its source, and the one or two things the seller can do. Seller job: "when do I get it, and what can I do?" Judge job: see a real `PENDING` capture explained in Hindi with a cited rule (storyboard 0:45–1:05).

## Layout
**Inbox:** h1 "Held money". The total held is shown per currency at the `money` step ("$604.00 USD held in 3 payments": $120.00 dispute-linked, $64.00 payment review, $420.00 goods). Below it: hold rows (`PaymentRow` with the `held` badge + reason + `EstimatedDate`), then the **"Sample scenarios"** section (h2), whose three explainers each carry the Sandbox badge "Sample scenario: sandbox can't produce this": new-seller hold (21 days), reserve, and account limitation.

**Detail**, sections in order:
1. **Header:** amount (`MoneyCell`), `held` badge + `status_details.reason` (e.g. `PENDING_REVIEW`), opened time, and the link to the payment and to the dispute if `BUYER_COMPLAINT`.
2. **Why it's held** (M3-02): the summary (≤ 2 sentences), "What PayPal is doing" and "What you can do" (≤ 3 items), with a `Citation` to the rule. Before M3-02 ships, this section shows the rule row's own description with its source.
3. **Estimated release:** `EstimatedDate` in its full form. Examples: `payment_review`: "Within 24 hours; up to 3 business days · estimated · Source"; `dispute_hold`: "Released when the dispute is resolved · Dispute reply due 2 Nov" (link); `goods_delivered`: "About 24 hours after the courier confirms delivery · estimated"; no rule: "PayPal gives no timeline for this reason" + Source.
4. **Action slot** (one primary action at most):
   - goods (M3-03): **Route advice**: the chosen carrier and its tier badge (`approved`: `completed` colours, `truck` icon, "Faster release expected"; `accepted`: `held` colours, `triangle-alert`, "PayPal accepts it; it may not speed up the release"; `other`: neutral, `circle-help`, "Unconfirmed carrier"), the approved alternatives for the country, and the caveat "Sandbox US account list; live and other-country accounts may differ" + Source. Then **"File tracking"** → `ApprovalCard` (`add_tracking`: carrier code, tracking number, `notify_payer: false`).
   - service (M3-04): the **guided Completed step** (primary) and, below it, the subordinate "Also record it with PayPal's API" card. Shown on `service` holds that are not released. See [M3-04 guided Completed step](#m3-04-guided-completed-step).
   - declaration (BL-01 6570499264): on holds PayPal didn't type goods/service, the "What did you sell?" block comes first; the seller's answer then picks the goods or service content above. See [Seller's declaration](#sellers-declaration-what-did-you-sell-bl-01-6570499264-adr-0017-addendum-3).
   - none: "Nothing to do. PayPal will update this payment; we'll tell you when it changes."
5. **Timeline:** opened → explained → action proposed → approved → filed → released (or still held), mirroring the hold state machine. "Released" appears only when the capture reads `COMPLETED`.

**375 px:** a single column. The explanation comes first, and the `EstimatedDate` wraps to two lines without dropping "estimated". Route advice lists alternatives as a vertical list (each a 44 px row with name and code), and "File tracking" is full width at the end of the action slot. Sample scenario cards are full width. No horizontal scroll in HI (Devanagari lines run longer: the layout never relies on single-line text).

**768 px:** max width 720 px; route advice alternatives in two columns.

**1440 px:** inbox list on the left (max 760 px) and the selected hold's detail in the right pane (as on the dashboard). The detail page itself uses one 720 px column so the explanation stays readable.

**Light and dark:** from tokens. Tier badges use status families plus icons, so they work in greyscale.

### M3-04 guided Completed step
Service sellers have no tracking number. PayPal's own path for them is a manual status change on the PayPal website, and PayPal states the release timing for it. The API route exists, but PayPal support could not confirm it has the same effect, so it is offered second and labelled that way. Sources (the only facts this section relies on):
- **help129** (https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129, retrieved 2026-11-02): "We'll release the hold 7 days after you confirm the order status as Completed."
- **PayPal support reply, 26 Oct 2026** (web path): "For services or intangible items, you can update the order status to "Completed" in your Activity section to help release the hold."
- **PayPal support follow-up, 26 Oct 2026:** "information confirming that an API-based "Completed" status update is functionally identical to the manual web update is not available."

**Anatomy, top to bottom** (inside the detail's action slot, under "Estimated release"):

**A. Guide (primary).** An h3 "Mark the order Completed in PayPal". One intro sentence ("PayPal says it releases a service hold 7 days after you mark the order Completed") plus a `Citation` chip to help129. Then a numbered `<ol>` of three steps, each a 32 px step number (`text-muted`, tabular) + text:
1. "Open your PayPal Activity." A **secondary** button-link "Open PayPal Activity" with a lucide `external-link` icon. It opens PayPal's Activity page in a new tab on the environment's host: `www.sandbox.paypal.com` when `PAYPAL_ENV=sandbox`, `www.paypal.com` in live. The host is printed under the link in mono (`text-xs`, "Opens www.sandbox.paypal.com"), followed by the `SandboxBadge` pill when sandbox. The URL comes from config per environment, never from copy. The builder checks that the Activity page resolves in sandbox before shipping.
2. "Find this payment. Search for its transaction ID." The capture ID in its own box (`surface-sunken`, `radius-sm`, mono `text-sm`, `overflow-wrap: anywhere`, so a long ID wraps inside the box and never widens the page). A **Copy** button (`copy` icon + "Copy ID", 44 px) sits beside it, and below it at ≤ 375 px. Copying shows the toast "Copied".
3. "Update the order status to Completed."

Under the list: a **quote block** (Citation style: `surface-sunken`, 3 px `border-strong` left rule, `quote` icon) holding PayPal support's web-path sentence verbatim in English (`<blockquote lang="en">`), captioned "PayPal support, 26 Oct 2026". In HI, the caption says the quote is in English. The quote is never translated or paraphrased.

**B. Confirm.** A hairline divider, then the label "Date you marked it Completed" over a native `<input type="date">`. It defaults to today in the workspace time zone, with `max` = today and `min` = the hold's opened date, both in the workspace time zone. A hint below reads "Today or earlier, not before {openedDate}". Then the **primary** button "I marked it Completed in PayPal" (48 px; full width at ≤ 375 px). Submitting writes an audit row (actor: the seller, `user` "You") and sets the estimate to confirmed date + 7 days (source help129). Server-side, the hold goes to `filed`.

**C. Confirmed (collapsed guide).** After a successful save, A and B are replaced in place by a compact block with a `circle-check` icon in `status-completed-fg`. The heading reads "You marked it Completed on {date}". Below it is the `EstimatedDate` "About {date} · estimated · Source", where Source opens the help129 quote, link and retrieved date, plus a link "See the audit entry". A disclosure "Show the steps again" re-opens the read-only guide, for reference only. The seller sees the toast "Saved. Estimate: about {date}." The page's "Estimated release" section shows the same estimate. The timeline's current step becomes **filed**, labelled "Marked Completed in PayPal by you · {date}". This is the seller's own confirmation, not a PayPal state: the hold stays `held` / `PENDING` until PayPal reports `COMPLETED`.

**D. Also record it with PayPal's API (secondary).** This is a disclosure button below the guide (or below the confirmed block), separated by a hairline divider. It uses `text-sm` with a `chevron-down` icon and is collapsed by default. It is the visually subordinate path: no filled button shows until the seller opens it. Next to its label it always carries a visible badge: the `held` status family, a `triangle-alert` icon and the text **"Effect on release unconfirmed"**. The badge text is part of the button's accessible name. When open, it shows:
- One line: "This doesn't change your estimate; only the step above does."
- A nested disclosure "Why unconfirmed?" quoting the PayPal support follow-up verbatim (`<blockquote lang="en">`, captioned "PayPal support, 26 Oct 2026").
- An `ApprovalCard` for the action `record_service_completed`. Its heading is "Record the order as Completed with PayPal's API", with the capture ID in mono. **What PayPal receives:** transaction (capture) ID, `status: COMPLETED`, tracking number "None (service)". No carrier is sent: PayPal refuses a carrier without a tracking number (live sandbox 400 `TRACKING_NUMBER_IS_MISSING`, M3-04). Below that: "Draft fingerprint `xxxxxxxx`" (first 8 characters of `payload_sha256`) with a copy button for the full hash, plus the standard note. The card has no deadline row and no "Allowed by PayPal" row: neither applies to this action. Flow: **Review** (secondary; expands the payload list) → **Approve and record** → confirm dialog → states below.
- Approve uses the **secondary** variant here, which deliberately departs from the ApprovalCard default. This keeps one primary per view (the guide's confirm button) and keeps the unconfirmed path visually second. It is 48 px high and full width at ≤ 375 px.
- Confirm dialog: "This asks PayPal to record the order as COMPLETED. It doesn't change your estimate, and PayPal hasn't confirmed it affects when the money is released." Buttons: "Record with PayPal" / "Go back". Initial focus goes to "Go back".
- Card states: **proposed** (payload + fingerprint); **recording** (busy button "Recording with PayPal…" with a 16 px spinner); **recorded** ("Recorded after your approval · PayPal reads `COMPLETED` · debug_id `…`", from PayPal's read-back, plus the toast "Recorded with PayPal"); **failed** ("PayPal didn't record it", with the localised refusal code from the ApprovalCard set, e.g. `APPROVAL_HASH_MISMATCH`, `KILL_SWITCH`, `RECONCILE_NOT_APPLIED`); **unknown** ("PayPal didn't answer; we'll check its record and never resend."). The "Effect on release unconfirmed" badge stays visible in every state, including recorded. No state of this card changes the `EstimatedDate`, the timeline's filed step, or any copy about release.

**Never** in this slot: any wording that says or implies the API call releases, frees, unlocks or speeds up the money. The only release timing shown is help129's 7 days after the seller's own confirmation, always labelled "estimated".

**Layout.**
- **360–375 px:** single column. Step text wraps freely, and the HI layout never relies on single-line text. The "Open PayPal Activity" link, the date input, the confirm button, the API disclosure button, Review and Approve are all full width and at least 44 px high (primary 48 px). The ID box wraps inside itself, and the Copy button sits below it. There is no horizontal page scroll in EN or HI. The quote blocks wrap, and long URLs in Source panels break with `overflow-wrap: anywhere`.
- **768 px:** within the 720 px column. The ID box and Copy button share one row. The date input (auto width, min 200 px) and the confirm button share one row if they fit, and otherwise stack. The card buttons size to their content.
- **1440 px:** the same 720 px column in the detail pane. Nothing new beside it.

### Seller's declaration: "What did you sell?" (BL-01 6570499264, ADR 0017 addendum 3)
PayPal never says whether a held payment was goods or a service. The seller says it, and the answer only picks the action-slot content (goods → route advice + "File tracking"; service → the guided Completed step). It is **the seller's answer, never PayPal's classification**, and it never changes the hold's reason, badge or estimate.

**Where.** First block of the action slot (4), on unreleased holds PayPal didn't type `goods`/`service` (payment review, dispute, other). Not on samples or released holds. When PayPal already typed the hold, the block is absent.

**Anatomy** (card: `surface`, 1 px `border`, `radius-lg`, 16 px padding, 12 px gaps):
- h3 "What did you sell?" (`text-lg`, semibold; `tabindex="-1"`, focus target after saving).
- **Undeclared:** a `<fieldset>` with `<legend>` "This payment was for" and two radio cards side by side from 768 px, stacked below: each a `<label>` ≥ 48 px high, 1 px `border-strong`, `radius-md`; the checked card gets a 2 px `accent` border. Title (`font-medium`) "Goods" / "A service", hint (`text-sm`, `text-muted`) "Items you ship" / "Work you deliver, no parcel". Under it the hint (`text-sm`, `text-muted`, linked to the fieldset by `aria-describedby`): "PayPal doesn't say. Your answer only picks what you can do below. It doesn't change why PayPal is holding this payment or its estimate." Then the **primary** "Save" (48 px; full width ≤ 375 px). Answering is optional: below the card the "none" line ("Nothing to do. PayPal will update this payment…") still shows until the seller answers.
- **Declared:** the line "You marked this as goods" / "You marked this as a service" (`user-round` icon, `font-medium`), then the note (`text-sm`, `text-muted`): "This is your answer, not PayPal's. The estimate above is still PayPal's for this hold; filing tracking doesn't change it." (service: "…; marking it Completed doesn't change it."). Then a text button "Change" (44 px, `accent`, underlined; accessible name "Change what you sold") that reopens the radios with "Cancel".
- **Locked** (an action was approved, or Completed confirmed): no Change; a `lock` icon + "Locked: you approved an action on this payment." (`text-sm`, `text-muted`). After the Completed confirmation it reads "Locked: you marked it Completed."
- **Ship first** (declared goods on a hold whose rule carries PayPal's "Don't ship until we tell you it's ok", i.e. a payment review): above route advice, an `info` icon + `text-sm` line "PayPal asks you not to ship until it clears this review. Once PayPal clears it and you ship, file the tracking here." It reconciles PayPal's don't-ship advice with the tracking form; hidden once tracking is filed.
- **Dashboard row** (`HeldLines`): the same "You marked this as goods" line in `text-sm`, under the estimate and advice.

**Copy rules on a declared hold PayPal didn't type** (the #35 research: a review hold releases at ~24 h with or without tracking):
- Never shown: "Tracking can help release this", "Faster release expected: about 24 h after delivery is confirmed", "Approved carriers for a faster release", "Faster: …", "Source: carriers for faster release", "Shipping goods? Faster release …", and help129's "PayPal says it releases a service hold 7 days after you mark the order Completed".
- Route advice uses `holds.tracking.neutral.*`: tier text "PayPal lists it as an approved carrier" / "PayPal accepts it" / "Unconfirmed carrier: PayPal accepts it", "Approved carriers", "Approved: {carriers}", "Source: approved carriers". Tier badges, alternatives, sources and the caveat are unchanged.
- The Completed guide's intro is "PayPal's 7-day rule is for holds PayPal places on service payments. This hold is PayPal's own (see why it's held), so marking it Completed won't change its estimate." Saving shows the toast "Saved. Your estimate hasn't changed." Block C shows PayPal's own estimate.
- "Estimated release" (3) always shows PayPal's rule for the reason (e.g. `payment_review`: "Within 24 hours; up to 3 business days · estimated").

**States.** Saving: "Saving…" busy button, radios disabled. Save failed: inline `status-error-fg` "Couldn't save your answer. Nothing changed. Try again." + Reference; a refusal shows "Not saved: {code}" (`NOT_DECLARABLE`), and `DECLARATION_LOCKED` reads "You already acted on this payment, so your answer is locked (DECLARATION_LOCKED)." Choosing a radio clears any error; offline hides it. Nothing chosen: "Choose goods or a service." Offline: Save disabled with "You're offline. Reconnect to save this." (`aria-describedby`). After saving: focus to the h3, live region "Saved: you marked this as goods."

**Accessibility.** Native radios in a fieldset/legend (arrow keys move between them); every control ≥ 44 px; the declared line is text + icon, never colour alone. HI keys under `holds.declaration`.

| Key | EN | HI |
|---|---|---|
| holds.declaration.title | What did you sell? | आपने क्या बेचा? |
| holds.declaration.legend | This payment was for | यह भुगतान किसके लिए था |
| holds.declaration.kind.goods / .service | Goods / A service | सामान / सेवा |
| holds.declaration.marked.goods | You marked this as goods | आपने इसे सामान बताया है |
| holds.declaration.marked.service | You marked this as a service | आपने इसे सेवा बताया है |
| holds.declaration.locked | Locked: you approved an action on this payment. | बदला नहीं जा सकता: आपने इस भुगतान पर एक कार्रवाई मंज़ूर की है। |
| auditLog.action.hold_declared | You marked the payment as {what} | आपने भुगतान को {what} बताया |

## Components
`MoneyCell`, `StatusBadge` (held, completed, dispute, sandbox), `EstimatedDate`, `Citation`, `ApprovalCard`, `SandboxBadge`, `EmptyState`, `LoadingState`, `ErrorPanel`, `Toast` ("Tracking filed"; M3-04: "Copied", "Saved. Estimate: about {date}.", "Recorded with PayPal"). M3-04 adds a native date input and a quote block (Citation styling); no new shared component.

## States
| State | What shows |
|---|---|
| Loading | Total skeleton + 2 row skeletons; after 3 s "Loading held money…" |
| Empty | Icon `circle-check`: "No held money. Every payment is with you or on its way." The Sample scenarios section still shows |
| Success | Rows + detail as above |
| Explanation pending | "Writing a plain-language explanation… usually under 30 seconds." The rule description shows meanwhile |
| Explanation unavailable (partial) | AI down or budget reached: the rule description + source are shown, labelled "Rule text from PayPal (no AI summary right now)" |
| Tracking filing | `ApprovalCard` states; success toast "Tracking filed", and the estimate switches to "After the courier confirms delivery · estimated" (no invented date) |
| Released | `completed` badge "Completed" + "Released {time}" (from PayPal); the hold leaves the inbox on the next poll, with an announcement |
| Still held | "Still held after the estimate. PayPal hasn't released it yet." + what to check, with no blame |
| Error | `ErrorPanel` "Couldn't load held money", Retry, Reference |
| Offline | Last data + offline banner; "File tracking" disabled with the reason |
| Completed step · loading | Slot skeleton: an h3 bar, three 44 px step rows and a 48 px button bar. After 3 s: "Loading the steps for this payment…" |
| Completed step · empty | Not a `service` hold, or PayPal has released it: the slot shows the "none" line. Hold not found in this workspace: `ErrorPanel` not-found variant "We can't find this held payment in your workspace" with a link back to Held money |
| Completed step · error | Slot-level partial band (`status-error-bg`): "Couldn't load the Completed step" + Retry + Reference. The rest of the detail page stays usable |
| Completed step · date invalid | Inline field error (`status-error-fg`, `circle-x`): future date → "Pick today or an earlier date."; before opened → "Pick {openedDate} or later; PayPal started holding this payment that day." The button stays enabled, and validation runs on submit and on the server |
| Completed step · saving | Confirm button busy "Saving…"; the date input is read-only while saving |
| Completed step · save failed | Inline error under the button: "Couldn't save your confirmation. Nothing changed. Try again." + Reference. The guide stays open and the entered date is kept |
| Completed step · confirmed | Block C: "You marked it Completed on {date}" + "About {date} · estimated · Source", toast, timeline at filed. Shown on every later visit until PayPal reports the release |
| Completed step · API card | proposed / recording / recorded / failed / unknown as in block D. The estimate never changes. "Effect on release unconfirmed" is always visible |
| Completed step · offline | The guide and quote stay readable, and "Open PayPal Activity" and Copy still work. "I marked it Completed in PayPal" and "Approve and record" are disabled with the reason "You're offline. Reconnect to save this." (linked by `aria-describedby`) |

## Interactions
- SWR every 5 s. Release and status changes flash and are announced.
- "Source" opens the rule quote, its link and `retrieved_at`.
- "File tracking" opens the `ApprovalCard` inline, prefilled from shipment evidence. Editing a field creates a new fingerprint.
- A sample scenario opens an explainer page with the Sandbox "Sample scenario" badge at the top. It shows no amount from any real payment and has no actions.
- **Completed step (M3-04):** "Open PayPal Activity" opens a new tab and Cleared does not poll PayPal's website. Copy writes the capture ID only. The confirm button posts `{ holdId, completedOn: YYYY-MM-DD }`, and the server re-checks the date range in the workspace time zone and that the hold is `service` and unreleased. On success the slot swaps to block C in place, and focus moves to its heading (`tabindex="-1"`). A second confirmation is refused server-side (idempotent: it returns the existing record). The API disclosure, "Review", "Approve and record" and the dialog follow the `ApprovalCard` rules. Unknown is reconciled by reading the capture back and is never resent.
- Keyboard path: Skip link → total-held link (filters) → each hold row → in detail: payment/dispute link → explanation citation → "Source" disclosure → route advice alternatives → "File tracking" → `ApprovalCard` controls (service holds instead: help129 citation → "Open PayPal Activity" → Copy ID → support quote → date input → "I marked it Completed in PayPal" → "Also record it with PayPal's API" → "Why unconfirmed?" → Review → copy hash → Approve and record) → timeline links → back to inbox → "Sample scenarios" links.

## Copy
| Key | EN | HI |
|---|---|---|
| title | Held money | रोका गया पैसा |
| total | {amount} held in {count, plural, one {# payment} other {# payments}} | {count} भुगतानों में {amount} रोका गया |
| reason.PENDING_REVIEW | PayPal is reviewing this payment | PayPal इस भुगतान की जाँच कर रहा है |
| reason.BUYER_COMPLAINT | Held because the buyer opened a dispute | ख़रीदार ने विवाद खोला है, इसलिए रोका गया |
| est.review | Within 24 hours; up to 3 business days | 24 घंटे में; ज़्यादा से ज़्यादा 3 कामकाजी दिन |
| est.dispute | Released when the dispute is resolved | विवाद निपटने पर रिलीज़ होगा |
| est.delivered | About 24 hours after the courier confirms delivery | कूरियर की डिलीवरी पुष्टि के लगभग 24 घंटे बाद |
| est.none | PayPal gives no timeline for this reason | इस कारण के लिए PayPal कोई समय-सीमा नहीं बताता |
| estimated | estimated | अनुमानित |
| tier.approved | Faster release expected: about 24 h after delivery is confirmed | जल्दी रिलीज़ की उम्मीद: डिलीवरी की पुष्टि के लगभग 24 घंटे बाद |
| tier.accepted | PayPal accepts it; it may not speed up the release | PayPal इसे मानता है; इससे रिलीज़ शायद जल्दी न हो |
| caveat | Sandbox US account list; live and other-country accounts may differ | सैंडबॉक्स US खाते की सूची; असली और दूसरे देशों के खातों में यह अलग हो सकती है |
| fileTracking | File tracking | ट्रैकिंग दर्ज करें |
| trackingFiled | Tracking filed | ट्रैकिंग दर्ज हो गई |
| sample.badge | Sample scenario: sandbox can't produce this | नमूना स्थिति: सैंडबॉक्स इसे नहीं बना सकता |
| sample.limitation.body | PayPal has limited the account. Cleared can't lift a limitation or promise a release; PayPal decides. This explains what PayPal usually asks for. | PayPal ने खाते पर रोक लगाई है। Cleared रोक नहीं हटा सकता और रिलीज़ का वादा नहीं कर सकता; फ़ैसला PayPal का है। यहाँ बताया गया है कि PayPal आम तौर पर क्या माँगता है। |
| empty | No held money. Every payment is with you or on its way. | कोई पैसा रुका नहीं है। हर भुगतान आपके पास है या आ रहा है। |

M3-04 keys live under `holds.completed`. "Completed" is the label the seller sees in PayPal's UI, so it stays Latin in HI (`<span lang="en">`). The enum `COMPLETED` stays in `<code lang="en">`. Verbatim PayPal quotes are not translated.

| Key | EN | HI |
|---|---|---|
| holds.completed.title | Mark the order Completed in PayPal | PayPal में ऑर्डर को Completed करें |
| holds.completed.intro | PayPal says it releases a service hold 7 days after you mark the order Completed. | PayPal के मुताबिक़, ऑर्डर को Completed करने के 7 दिन बाद सेवा वाले भुगतान की रोक हटती है। |
| holds.completed.step1 | Open your PayPal Activity. | अपनी PayPal Activity खोलें। |
| holds.completed.openActivity | Open PayPal Activity | PayPal Activity खोलें |
| holds.completed.opensHost | Opens {host} | {host} खुलेगा |
| holds.completed.newTab | (opens in a new tab) | (नए टैब में खुलेगा) |
| holds.completed.step2 | Find this payment. Search for its transaction ID. | यह भुगतान ढूँढें। इसकी ट्रांज़ैक्शन ID से खोजें। |
| holds.completed.copyId | Copy ID | ID कॉपी करें |
| holds.completed.copyIdLabel | Copy transaction ID {id} | ट्रांज़ैक्शन ID {id} कॉपी करें |
| holds.completed.copied | Copied | कॉपी हो गया |
| holds.completed.step3 | Update the order status to Completed. | ऑर्डर का स्टेटस बदलकर Completed करें। |
| holds.completed.supportCaption | PayPal support, 26 Oct 2026 | PayPal सपोर्ट, 26 अक्टू॰ 2026 (जवाब अंग्रेज़ी में) |
| holds.completed.dateLabel | Date you marked it Completed | Completed करने की तारीख़ |
| holds.completed.dateHint | Today or earlier, not before {openedDate} | आज या उससे पहले, पर {openedDate} से पहले नहीं |
| holds.completed.confirm | I marked it Completed in PayPal | मैंने PayPal में Completed कर दिया |
| holds.completed.saving | Saving… | सेव हो रहा है… |
| holds.completed.error.future | Pick today or an earlier date. | आज की या उससे पहले की तारीख़ चुनें। |
| holds.completed.error.beforeOpened | Pick {openedDate} or later; PayPal started holding this payment that day. | {openedDate} या उसके बाद की तारीख़ चुनें; उसी दिन PayPal ने यह भुगतान रोका था। |
| holds.completed.error.save | Couldn't save your confirmation. Nothing changed. Try again. | आपकी पुष्टि सेव नहीं हुई। कुछ नहीं बदला। फिर से कोशिश करें। |
| holds.completed.offline | You're offline. Reconnect to save this. | आप ऑफ़लाइन हैं। इसे सेव करने के लिए दोबारा कनेक्ट करें। |
| holds.completed.loading | Loading the steps for this payment… | इस भुगतान के कदम लोड हो रहे हैं… |
| holds.completed.loadError | Couldn't load the Completed step | Completed वाला कदम लोड नहीं हुआ |
| holds.completed.notFound | We can't find this held payment in your workspace | यह रोका गया भुगतान आपके वर्कस्पेस में नहीं मिला |
| holds.completed.done | You marked it Completed on {date} | आपने इसे {date} को Completed किया |
| holds.completed.estimate | About {date} | लगभग {date} |
| holds.completed.toast | Saved. Estimate: about {date}. | सेव हो गया। अनुमान: लगभग {date}। |
| holds.completed.announce | Saved. Estimated release about {date}. | सेव हो गया। अनुमानित रिलीज़ लगभग {date}। |
| holds.completed.timeline | Marked Completed in PayPal by you · {date} | आपने PayPal में Completed किया · {date} |
| holds.completed.auditLink | See the audit entry | ऑडिट एंट्री देखें |
| holds.completed.showSteps | Show the steps again | कदम फिर से दिखाएँ |
| holds.completed.api.toggle | Also record it with PayPal's API | PayPal के API से भी दर्ज करें |
| holds.completed.api.badge | Effect on release unconfirmed | रिलीज़ पर असर की पुष्टि नहीं |
| holds.completed.api.noEstimate | This doesn't change your estimate; only the step above does. | इससे आपका अनुमान नहीं बदलता; सिर्फ़ ऊपर वाला कदम इसे बदलता है। |
| holds.completed.api.why | Why unconfirmed? | पुष्टि क्यों नहीं? |
| holds.completed.api.heading | Record the order as Completed with PayPal's API | PayPal के API से ऑर्डर को Completed दर्ज करें |
| holds.completed.api.fieldId | Transaction (capture) ID | ट्रांज़ैक्शन (capture) ID |
| holds.completed.api.fieldStatus | Status | स्टेटस |
| holds.completed.api.fieldTracking | Tracking number | ट्रैकिंग नंबर |
| holds.completed.api.noTracking | None (service) | कोई नहीं (सेवा) |
| holds.completed.api.fieldCarrier | Carrier | कैरियर |
| holds.completed.api.review | Review | देखें |
| holds.completed.api.approve | Approve and record | मंज़ूर करें और दर्ज करें |
| holds.completed.api.dialogBody | This asks PayPal to record the order as COMPLETED. It doesn't change your estimate, and PayPal hasn't confirmed it affects when the money is released. | इससे PayPal से ऑर्डर को COMPLETED दर्ज करने को कहा जाएगा। इससे आपका अनुमान नहीं बदलता, और PayPal ने पुष्टि नहीं की है कि इससे पैसा मिलने के समय पर कोई असर पड़ता है। |
| holds.completed.api.dialogConfirm | Record with PayPal | PayPal में दर्ज करें |
| holds.completed.api.dialogCancel | Go back | वापस जाएँ |
| holds.completed.api.recording | Recording with PayPal… | PayPal में दर्ज हो रहा है… |
| holds.completed.api.recorded | Recorded after your approval · PayPal reads COMPLETED · debug_id {debugId} | आपकी मंज़ूरी के बाद दर्ज हुआ · PayPal में स्टेटस COMPLETED · debug_id {debugId} |
| holds.completed.api.recordedToast | Recorded with PayPal | PayPal में दर्ज हो गया |
| holds.completed.api.failed | PayPal didn't record it: {reason} | PayPal ने इसे दर्ज नहीं किया: {reason} |
| holds.completed.api.unknown | PayPal didn't answer; we'll check its record and never resend. | PayPal ने जवाब नहीं दिया; हम उसका रिकॉर्ड जाँचेंगे और दोबारा कभी नहीं भेजेंगे। |

## Accessibility
- h1 "Held money" / "Held: {amount} from {buyer}". The timeline is an `<ol>` with `aria-current="step"`.
- `EstimatedDate`'s accessible name always includes "estimated" and the source name.
- Tier badges have icon + label; the alternatives list is a `<ul>` with each carrier's full name and PayPal code.
- 375 px: all actions ≥ 44 px; "File tracking" is 48 px and full width.
- **Completed step (M3-04):** the steps are an `<ol>` under an h3. The capture ID is `<code lang="en">`, and Copy's accessible name is "Copy transaction ID {id}". "Open PayPal Activity" has the accessible name "Open PayPal Activity on {host} (opens in a new tab)", and in sandbox it ends with "(sandbox)". The support quotes are `<blockquote lang="en">` with a visible `<figcaption>`. The date input has a visible `<label>`, `min`/`max`, and the hint plus any error linked via `aria-describedby`. An error sets `aria-invalid="true"` and is announced once on submit. After saving, focus goes to the confirmed heading and the page live region says "Saved. Estimated release about {date}." The API disclosure is a `<button aria-expanded>` whose name includes "Effect on release unconfirmed". That badge is icon + text and never colour alone. All slot controls are ≥ 44 px at < 768 px. The primary is 48 px and full width at ≤ 375 px.
- HI: the explanation is rendered with `lang="hi"` and `lineHeightHi`. PayPal enums stay Latin inside `<code lang="en">`.
