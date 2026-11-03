# Screen: dispute review

Routes `/[locale]/disputes` (list) and `/[locale]/disputes/[disputeId]` (detail). Built by **M2-09** (on M2-06 sync, M2-07 draft and M2-08 governance). The scenario timeline and **"Simulate PayPal's decision (sandbox only)"** are added by **M2-10**.

## Purpose
A dispute arrives, and its reply is already drafted from the proof pack. The seller reviews exactly what will go to PayPal, approves it once, and watches PayPal's real states change until the outcome. Seller job: "answer this before the deadline, without being rushed or tricked." Judge job: see the approval gate, the cited draft, the labelled sandbox decision and the honest outcome wording.

## Layout
**List** (`/disputes`): `PaymentRow`-style rows with the amount, the `dispute` badge + PayPal status and stage, the reason in words + enum, the due date in the workspace tz with a countdown, and a deadline badge (`t72`: `held` colours, `clock` icon, "Due in 2 days"; `t24`: `status-error`, `alarm-clock`, "Due in 18 hours"; `closed_for_action`: neutral, `lock`, "Too late to reply here"). Sorted by due date.

**Detail**, sections in order:
1. **PayPal facts:** amount, `StatusBadge` (`dispute` or `resolved`) + the exact PayPal status (`WAITING_FOR_SELLER_RESPONSE`), reason (`MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, "Item not as described"), dispute ID (mono), the linked payment and its hold ("Held: PENDING / BUYER_COMPLAINT"), "Reply due 2 Nov 2026, 23:59 IST", and "PayPal currently allows: provide evidence, accept claim" (from the live HATEOAS links).
2. **Draft reply** (`ApprovalCard`, see components):
   - the notes as plain text, editable in a textarea, with a live count "1,412 / 2000" (it turns to `danger` with "Over the 2000-character limit" above 2000, and Approve is disabled)
   - the evidence type + the reason-map explanation ("PayPal asks for proof the item matched its description; this reply sends the agreed scope and the delivered files.")
   - the selected evidence items (checkboxes, each with a `Citation` link to the pack), and the compiled PDF ("Reply evidence.pdf, 2.4 MB" + Download)
   - **auto-added items** (BL-01 6595501766, owner decision 2026-11-03): code always adds the pack's newest client sign-off and scope snapshot to the agent's selection, inside the compiled PDF the fingerprint covers. When the draft has one, a `text-sm` `text-muted` line `autoHint` sits under `itemsHint`; the item's label gets a second line `autoAdded` (`file-plus` 14 px) while it stays ticked. An item left out to stay within PayPal's limits stays unticked with `autoLeftOut.<code>` (`info` 14 px) on that second line: never a silent drop. Both lines are inside the checkbox label, so they are part of its accessible name
   - the draft fingerprint `9f3c1a7e` and the Approve flow
   - "Other options" disclosure: **Accept claim** (Destructive), behind the typed confirmation "Type 120.00 USD to confirm"
3. **Filing status:** a vertical stepper (a real sequence): proposed → approved → sending → (checking with PayPal) → filed, or failed with the localised refusal and `debug_id`.
4. **Outcome** (when RESOLVED): `resolved` badge + the outcome sentence (copy below) + "Hold released: payment is Completed" once the capture reads `COMPLETED` (a `completed` badge, mirrored, never set by the UI).
5. **Judge scenario** (M2-10, demo and owner workspaces only): `ScenarioTimeline` (each step with its PayPal ID, timestamp and observed status; expected waits stated, for example "PayPal usually opens the evidence step within ~15 min") and the Sandbox control **"Simulate PayPal's decision (sandbox only)"** with the helper text "Stands in for PayPal's own review. Only available in the sandbox, after your evidence is filed."
6. **Audit trail:** `AuditRow`s for this dispute (actor, action, time, `debug_id`).

**375 px:** a single column. Facts become a definition list with stacked pairs. The notes textarea is full width (min 10 rows) with the count sticky under it. Evidence items are 56 px rows with 44 px checkboxes. Approve is full width and 48 px, placed **after** the payload and fingerprint so the seller scrolls past what is sent. The sandbox control is full width, dashed, below the timeline and separated from Approve by the filing-status section, never adjacent to it. Due date and countdown sit in a sticky band under the header ("Reply due in 2 days").

**768 px:** max width 720 px; facts in a two-column definition list.

**1440 px:** two columns. Left (7/12): facts, draft, approval. Right (5/12, sticky): filing status, outcome, scenario timeline and sandbox control, audit trail.

**Light and dark:** as tokens. The sandbox control is distinguishable in both by its dashed boundary and flask icon, not only its tint.

## Components
`StatusBadge` (dispute, resolved, completed, held, sandbox), `MoneyCell`, `ApprovalCard`, `Citation`, `SandboxBadge` + Sandbox button, `AuditRow`, `ErrorPanel`, `EmptyState`, `LoadingState`, `Toast` ("Reply approved"), plus `ScenarioTimeline` and `SandboxDecision` (M2-10).

## States
| State | What shows |
|---|---|
| Loading | Facts skeleton + card skeleton; after 3 s "Loading the dispute from PayPal…" |
| Empty list | `EmptyState` icon `scale`: "No disputes. If a buyer opens one, it appears here with a reply already drafted from your proof." Demo: plus the Sandbox button "Run the dispute scenario" |
| Drafting | "The agent is drafting a reply from your proof pack… usually under a minute." |
| Draft ready (success) | The `ApprovalCard` in `proposed` |
| Draft unavailable (partial) | AI unavailable or budget reached: "Draft unavailable. You can still reply in PayPal yourself." + a link to PayPal's Resolution Center (sandbox) + the evidence list for download |
| Approving / sending / checking / filed / failed | `ApprovalCard` states (components) mirrored in the stepper. Refusals: `DEADLINE_PASSED` "PayPal's deadline is less than 1 hour away, so Cleared won't file. Reply in PayPal directly."; `ACTION_LINK_MISSING` "PayPal no longer allows this reply on this dispute."; `KILL_SWITCH` "Sending is paused by the operator."; `RECONCILE_NOT_APPLIED` "PayPal didn't record the reply. Review and approve again."; `APPROVAL_HASH_MISMATCH` "This draft changed. Review the new version and approve again." |
| Too late | `closed_for_action`: the draft becomes read only; "Too late to reply here." |
| Kill switch on | A banner above the card: "Sending to PayPal is paused. Your draft is saved." and Approve disabled with that reason |
| Waiting for PayPal (scenario) | Timeline step "Waiting for PayPal to open the evidence step" + "usually within ~15 min" + the last-checked time |
| Decision unavailable | Sandbox control disabled with "PayPal isn't ready yet: it hasn't offered the decision step." (no `adjudicate` link) or "File your evidence first." |
| Resolved (success) | Outcome sentence + hold released |
| Error | `ErrorPanel` "Couldn't load this dispute", Retry, Reference (+ `debug_id` if from PayPal) |

## Interactions
- Editing the notes or the evidence selection calls `draft/revise` (debounced 800 ms after the last change, or on blur). The fingerprint updates (old one shown struck through for 5 s) and Approve binds to the new hash.
- Approve → confirm dialog ("This sends the reply above to PayPal. You can't withdraw it after it's sent." Send to PayPal / Go back; initial focus "Go back") → busy → states poll every 5 s.
- Accept claim stays disabled until the typed text equals the amount + currency exactly ("120.00 USD").
- "Simulate PayPal's decision (sandbox only)" asks for confirmation: "This asks the PayPal sandbox to decide the case in your favour, standing in for PayPal's review. Real PayPal never offers this." Confirm / Cancel. The outcome is shown only after the dispute sync returns it.
- Keyboard path: Skip link → back to disputes → PayPal facts (dispute ID copy, linked payment) → notes textarea → each evidence checkbox and its citation → PDF download → copy fingerprint → Edit/Approve → (dialog: Go back, Send to PayPal; Escape cancels) → "Other options" (Accept claim field, button) → timeline step links → "Simulate PayPal's decision (sandbox only)" → audit rows.

## Copy
| Key | EN | HI |
|---|---|---|
| outcome.payout | Resolved; you keep the money (PayPal covered the case) | निपटारा हुआ; पैसा आपके पास रहेगा (PayPal ने मामला कवर किया) |
| outcome.thirdPerson (timeline, README) | Resolved; seller keeps the money (PayPal covered the case) | निपटारा हुआ; विक्रेता के पास पैसा रहेगा (PayPal ने मामला कवर किया) |
| outcome.other | Resolved: {PayPal outcome in words} ({outcome_code}) | निपटारा हुआ: {PayPal का नतीजा} ({outcome_code}) |
| holdReleased | Hold released: payment is Completed | रोक हटी: भुगतान पूरा हुआ |
| sandbox.decide | Simulate PayPal's decision (sandbox only) | Simulate PayPal's decision (sandbox only) |
| sandbox.help | Stands in for PayPal's own review. Only available in the sandbox, after your evidence is filed. | यह PayPal की अपनी समीक्षा की जगह लेता है। सिर्फ़ सैंडबॉक्स में, आपका सबूत दर्ज होने के बाद। |
| approve | Approve and send | मंज़ूर करें और भेजें |
| confirm.body | This sends the reply above to PayPal. You can't withdraw it after it's sent. | यह ऊपर दिया जवाब PayPal को भेजेगा। भेजने के बाद इसे वापस नहीं लिया जा सकता। |
| count | {n} / 2000 | {n} / 2000 |
| filed | Filed after your approval · PayPal debug_id {id} | आपकी मंज़ूरी के बाद दर्ज किया गया · PayPal debug_id {id} |
| checking | Checking with PayPal: the reply may have been received. We'll confirm within 10 minutes. | PayPal से पुष्टि हो रही है: जवाब शायद पहुँच गया है। 10 मिनट में पुष्टि करेंगे। |
| due | Reply due {date}, {time} {tz} | जवाब की आख़िरी तारीख़ {date}, {time} {tz} |
| draftUnavailable | Draft unavailable. You can still reply in PayPal yourself. | मसौदा उपलब्ध नहीं है। आप PayPal में ख़ुद जवाब दे सकते हैं। |
| autoHint | Cleared always adds your client's sign-off and the scope snapshot when your pack has them, within PayPal's limits. | आपके सबूत पैक में क्लाइंट की पुष्टि और दायरे का स्नैपशॉट हो, तो Cleared उन्हें PayPal की सीमाओं के भीतर हमेशा जोड़ता है। |
| autoAdded | Added by Cleared | Cleared ने जोड़ा |
| autoLeftOut.unsupported_type | Not added: PayPal accepts only JPG, GIF, PNG or PDF files. | नहीं जोड़ा: PayPal सिर्फ़ JPG, GIF, PNG या PDF फ़ाइलें लेता है। |
| autoLeftOut.file_too_large | Not added: this file is {size}, and PayPal takes files under 10 MB. | नहीं जोड़ा: यह फ़ाइल {size} की है, और PayPal 10 MB से छोटी फ़ाइलें ही लेता है। |
| autoLeftOut.pdf_too_large | Not added: with this item ({size}) the PDF would reach PayPal's 10 MB limit. | नहीं जोड़ा: इसे ({size}) जोड़ने पर PDF, PayPal की 10 MB की सीमा तक पहुँच जाएगी। |
| autoLeftOut.unreadable | Not added: Cleared couldn't read this file. | नहीं जोड़ा: Cleared यह फ़ाइल पढ़ नहीं सका। |

`outcome.payout` is used only for `RESOLVED_WITH_PAYOUT` with `REPRESENTED_BY_PAYPAL`. Other outcomes are worded from PayPal's meaning, never as a victory or a loss of ours.

## Accessibility
- h1 "Dispute on {amount}" (HI "{amount} पर विवाद (dispute)"). The buyer's name is not stored (owner decision 2026-11-02), so the heading names the amount only; the dispute ID and the linked payment identify the case (M4-03, BL-01 6539205590). The stepper is an `<ol>` with `aria-current="step"`.
- State changes in the stepper and outcome are announced politely once. Refusals use `role="alert"` once.
- The character count is linked to the textarea via `aria-describedby` and announced only at 1900 and above 2000, not on every keystroke.
- The deadline is given as an absolute date and time in text (the countdown is supplementary).
- 375 px: Approve and the sandbox control are both ≥ 48 px high, full width, and separated by at least one section.
- The confirm dialog is `role="alertdialog"` with a labelled title and description and a focus trap.
