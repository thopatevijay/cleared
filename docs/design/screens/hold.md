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
   - service (M3-04): the guided Completed step.
   - none: "Nothing to do. PayPal will update this payment; we'll tell you when it changes."
5. **Timeline:** opened → explained → action proposed → approved → filed → released (or still held), mirroring the hold state machine. "Released" appears only when the capture reads `COMPLETED`.

**375 px:** a single column. The explanation comes first, and the `EstimatedDate` wraps to two lines without dropping "estimated". Route advice lists alternatives as a vertical list (each a 44 px row with name and code), and "File tracking" is full width at the end of the action slot. Sample scenario cards are full width. No horizontal scroll in HI (Devanagari lines run longer: the layout never relies on single-line text).

**768 px:** max width 720 px; route advice alternatives in two columns.

**1440 px:** inbox list on the left (max 760 px) and the selected hold's detail in the right pane (as on the dashboard). The detail page itself uses one 720 px column so the explanation stays readable.

**Light and dark:** from tokens. Tier badges use status families plus icons, so they work in greyscale.

## Components
`MoneyCell`, `StatusBadge` (held, completed, dispute, sandbox), `EstimatedDate`, `Citation`, `ApprovalCard`, `SandboxBadge`, `EmptyState`, `LoadingState`, `ErrorPanel`, `Toast` ("Tracking filed").

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

## Interactions
- SWR every 5 s. Release and status changes flash and are announced.
- "Source" opens the rule quote, its link and `retrieved_at`.
- "File tracking" opens the `ApprovalCard` inline, prefilled from shipment evidence. Editing a field creates a new fingerprint.
- A sample scenario opens an explainer page with the Sandbox "Sample scenario" badge at the top. It shows no amount from any real payment and has no actions.
- Keyboard path: Skip link → total-held link (filters) → each hold row → in detail: payment/dispute link → explanation citation → "Source" disclosure → route advice alternatives → "File tracking" → `ApprovalCard` controls → timeline links → back to inbox → "Sample scenarios" links.

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

## Accessibility
- h1 "Held money" / "Held: {amount} from {buyer}". The timeline is an `<ol>` with `aria-current="step"`.
- `EstimatedDate`'s accessible name always includes "estimated" and the source name.
- Tier badges have icon + label; the alternatives list is a `<ul>` with each carrier's full name and PayPal code.
- 375 px: all actions ≥ 44 px; "File tracking" is 48 px and full width.
- HI: the explanation is rendered with `lang="hi"` and `lineHeightHi`. PayPal enums stay Latin inside `<code lang="en">`.
