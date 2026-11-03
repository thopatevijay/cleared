# Screen: client acknowledgement (seller panel and public page)

Two surfaces, built by **M3-06**: the **seller panel** "Client acknowledgement" on the proof-pack page (`/[locale]/payments/[paymentId]/pack`, see [payment-detail.md](payment-detail.md)), and the **public page** `/[locale]/ack/[token]` that the seller's client opens. M3-07 later embeds the acceptance in the scope snapshot PDF.

## Purpose
PayPal asks service sellers for "an invoice or a contract signed by both parties", and the seller's scope text is one-sided. The client confirms "I agree to this scope" once, and Cleared records it as **client sign-off** evidence (time, IP address, browser, typed name, scope fingerprint).
- **Seller:** "Get my client to confirm what we agreed, in one link, and see when they have."
- **Client (buyer):** a stranger to Cleared, on a phone, often in a second language, opening a link from a chat. "Read what I'm agreeing to, confirm it, and know what's recorded about me."
- **Judge:** sees buyer-side evidence enter the pack, with honest copy about what is recorded and where it goes.

## Layout

**Seller panel.** A section (h2 "Client acknowledgement") in the pack page's main column, placed **after Facts and before Evidence** (section 4b in payment-detail). It concerns the pack's current `scope` evidence item only. Anatomy, top to bottom: a link-state badge (`StatusBadge` pattern, Cleared's own states, never PayPal's) + one line of detail; the state's body (below); at most one primary-for-this-panel action (Secondary variant: the page keeps its single Primary). At 1440 px it stays in the left (8/12) column, so the evidence list on the right can show the resulting `client_ack` item beside it.
- **Just created** (the only time the raw link exists in the browser): a read-only `<input>` (mono `text-sm`, `surface-sunken`, full width, `readonly`, selects all on focus) holding the full URL; "Copy link" (Secondary) beside it at ≥ 768 px and below it, full width, at 375; "Expires {date}"; the note `pack.ack.shareYourself`; "Revoke link" (Secondary, `danger` text) last.
- **Revoke confirm** (inline, replaces the action row; no modal): `pack.ack.revokeConfirm` text + "Revoke" (Destructive) and "Keep link" (Secondary). Never adjacent to "Copy link" at 375: the confirm row sits below the expiry line.

**Public page.** No session, no site navigation. Minimal `header`: wordmark "Cleared" (text), `SandboxBadge` ("Sandbox"), `LanguageSwitch` (EN | हिं). `main`, max width 640 px, in order:
1. h1 `ack.title`; line `ack.from` with the seller's display name (plain text; in a demo workspace the synthetic "Meera Studio"; `ack.sellerFallback` when there is none).
2. `MoneyCell` (amount + ISO code; no receivable line, no PayPal IDs, no buyer details).
3. h2 `ack.scopeHeading`, then the **scope block**: plain text only (`white-space: pre-wrap; overflow-wrap: anywhere`), body font (not mono), `surface-sunken`, 1 px `border`, `radius-md`, `p-4`, `dir="auto"`. `max-height: 50vh` (min 240 px) with `overflow-y: auto`; when it scrolls it is a focusable region (`tabindex="0"`, `role="region"`, `aria-label` = `ack.scopeHeading`) with the standard inset focus ring.
4. Form: "Your name" text input (`autocomplete="name"`, `maxlength="120"`, hint `ack.nameHint`), checkbox "I agree to this scope" (24 px box; the whole label row is the 44 px hit area), the recorded-data note `ack.recorded` (`text-sm`, `text-muted`, `info` icon), then **Confirm** (Primary, full width at 375, 48 px high).
5. `footer`: one `text-xs` line `ack.footer`. No links out.

**375 px (and 360):** single column, `px-4`; the header keeps wordmark, badge and switch on one row (badge wraps under the wordmark in HI if needed, never clipped). **768 px:** same column, max 640 px centred; seller panel puts the link input and "Copy link" on one row. **1440 px:** public page unchanged (640 px column; line length < 75 ch); seller panel as above.

**Light and dark:** tokens only. The scope block and the read-only link input use `surface-sunken` + `text` (≥ 4.5:1 both themes); errors use `danger` text with the `circle-x` icon.

## Components
`StatusBadge`, `MoneyCell`, `SandboxBadge`, `LanguageSwitch`, `Toast` ("Link copied"), `ErrorPanel` (with Reference), `EmptyState` pattern (public neutral page and success), buttons (Primary, Secondary, Destructive). Icons (lucide): `circle-check`, `clock`, `lock`, `x`, `circle-dashed`, `info`, `circle-x`, `file-plus`.

## States: seller panel
| State | Badge (icon, label, colours) | What shows |
|---|---|---|
| Loading | skeleton pill | Two skeleton lines inside the section |
| No scope item | none | `pack.ack.noScope` with an in-page link "Add the agreed scope" to the Evidence intake (no button) |
| No link yet | none | `pack.ack.intro` + "Create acknowledgement link" (busy: "Creating…") |
| Just created | `clock` "Waiting for your client", info | Link input, Copy link, "Expires {date}", `pack.ack.shareYourself`, Revoke link |
| Pending (after reload) | `clock` "Waiting for your client", info | `pack.ack.shownOnce` (the server stores only a hash), "Expires {date}", Revoke link |
| Expiry capped by workspace | same as pending | "Expires {date}, when this demo workspace ends" |
| Revoke confirm / revoking | unchanged | Inline confirm row; "Revoking…" busy on Revoke |
| Accepted | `circle-check` "Accepted", completed | "Accepted {time} {tz}" + `pack.ack.inEvidence` + link "View in evidence" (scrolls to and focuses the `client_ack` item). The typed name is **not** shown here; it lives only in the evidence item. No revoke (the evidence is immutable). The pack banner turns stale ("New evidence: re-checking.") |
| Expired | `lock` "Expired", neutral | "This link expired on {date} without a reply." + "Create a new link" |
| Revoked | `x` "Revoked", neutral | "You revoked this link on {date}." + "Create a new link" |
| Scope changed | `circle-dashed` "Scope changed", held | `pack.ack.scopeChanged` + "Create a new link". If the old link was accepted: the Accepted row stays, labelled "for an earlier version of the scope" |
| Create / revoke failed | unchanged | Inline error band (`status-error-bg`, `role="alert"` once): "Couldn't create the link." / "Couldn't revoke the link." + Retry + Reference |
| Copy failed | unchanged | The input text is selected; toast `pack.ack.copyFailed` |
| Offline | unchanged | Actions disabled with "You're offline. Links can be changed when you reconnect." |

The `client_ack` item in the Evidence list renders as a plain-language record, not raw JSON: `pack.list.ackBy`, `pack.list.ackMeta`, `pack.list.ackScope` (scope sha256, 8-character mono short form), `pack.list.ackSource`. The typed name appears only here.

## States: public page
| State | What shows |
|---|---|
| Form (default) | Layout above. Server-rendered; no loading skeleton. `<noscript>`: "Turn on JavaScript to confirm." |
| Validation error | Field-level: `aria-invalid="true"`, message below the field linked by `aria-describedby`, `circle-x` + `danger` text; focus moves to the first invalid field. Values kept |
| Submitting | Confirm busy: "Confirming…" (`aria-busy`), inputs read only |
| Success | Form replaced by a panel: `circle-check` (completed colours) + h2 `ack.success` + `ack.recordedAt` "Recorded {time}", where {time} is one formatted string that already includes the zone abbreviation (visitor's browser time zone, absolute) + `ack.successClose`. Focus moves to the h2. The typed name renders as plain text |
| Scope changed | No distinct state (ticket AC 3): a scope-changed token gets the neutral page, on load and on submit (a submit that returns it replaces the form with the neutral page) |
| No seller display name | Demo workspaces (no `users` row) show the demo scenario's synthetic seller "Meera Studio" (BL-01 6569232529, owner decision 2026-11-03). A seller workspace whose `users.display_name` is unset: `ack.from` and `ack.recorded` use `ack.sellerFallback` "The seller" for {seller} |
| Rate limited (429) | Inline band above Confirm (`role="alert"`): `ack.rateLimited`. Values kept; Confirm re-enabled |
| Neutral (invalid, unknown, expired, revoked, scope changed, already accepted) | One identical page and HTTP status for every case: `lock` icon (32 px), h1 `ack.neutralTitle`, `ack.neutralBody`. No seller name, amount or scope; no hint of which case it is |
| Error (5xx / network) | `ErrorPanel` "Couldn't record your confirmation." + "Your answer wasn't saved. Try again." + Retry (resubmits the kept values) + Reference |

## Interactions
- **Create:** POST `ack-links` → the panel shows the just-created state; focus moves to the link input; the live region says "Link created."
- **Copy link:** writes the URL to the clipboard → `Toast` (`role="status"`) "Link copied". Focus stays on the button.
- **Revoke:** "Revoke link" → confirm row, initial focus on "Keep link"; Escape = Keep link and returns focus to "Revoke link". After revoking, focus moves to "Create a new link".
- **Live:** the panel polls with the page (5 s). Pending → accepted flashes the badge and announces "Your client confirmed the scope." once; the new evidence item appears in the list.
- **Public submit:** client-side checks first (name 1..120 characters after trimming, box ticked), then POST; the server decides. A second submit after success is a no-op; reloading shows the neutral page, which `ack.successClose` warns about.
- **Safety:** scope text, seller name and typed name render as plain text (a scope with `<script>` shows literally). Page sends `noindex`, `Referrer-Policy: no-referrer`; no third-party scripts or fonts from other origins.
- **Keyboard path (seller):** … Facts citations → "Create acknowledgement link" → link input → Copy link → Revoke link → (Keep link / Revoke) → "View in evidence" → Evidence intake.
- **Keyboard path (public):** EN/हिं → scope region (arrow keys scroll) → Your name → I agree checkbox (Space) → Confirm → (success: focus on the success heading).

## Accessibility
- Public h1 `ack.title` (neutral page: `ack.neutralTitle`); h2 for the scope and success. Landmarks `header`, `main`, `footer`; no `nav` by design (no site navigation). `<html lang>` follows the locale; the scope block has `dir="auto"` and no `lang` (unknown language).
- Name input has a visible `<label>`; the hint and error are both in `aria-describedby`. The checkbox is a native `<input type="checkbox">` with its label; error text "Tick the box…" is associated with it.
- Targets: Confirm, Create, Copy, Revoke, Keep link and LanguageSwitch ≥ 44 px at 375; the checkbox row ≥ 44 px; ≥ 24 px everywhere on desktop.
- The seller's link input is `readonly` (not `disabled`) so it stays focusable and readable, labelled "Acknowledgement link".
- HI: Devanagari in labels and notes uses `lineHeightHi`; nothing clips at 360 px; amounts, dates and digits stay Latin.

## Copy
| Key | EN | HI |
|---|---|---|
| pack.ack.title | Client acknowledgement | क्लाइंट की पुष्टि |
| pack.ack.intro | Ask your client to confirm the agreed scope. Their confirmation is added to this pack as client sign-off. | अपने क्लाइंट से तय काम के दायरे की पुष्टि करवाएँ। उनकी पुष्टि इस पैक में क्लाइंट की मंज़ूरी के रूप में जुड़ जाएगी। |
| pack.ack.noScope | Add the agreed scope first. Your client confirms that exact text. | पहले तय काम का दायरा जोड़ें। आपका क्लाइंट ठीक उसी पाठ की पुष्टि करेगा। |
| pack.ack.addScope | Add the agreed scope | तय काम का दायरा जोड़ें |
| pack.ack.create | Create acknowledgement link | पुष्टि लिंक बनाएँ |
| pack.ack.createNew | Create a new link | नया लिंक बनाएँ |
| pack.ack.linkLabel | Acknowledgement link | पुष्टि लिंक |
| pack.ack.copy | Copy link | लिंक कॉपी करें |
| pack.ack.copied | Link copied | लिंक कॉपी हो गया |
| pack.ack.copyFailed | Couldn't copy. The link is selected; copy it yourself. | कॉपी नहीं हो सका। लिंक चुना हुआ है; इसे ख़ुद कॉपी करें। |
| pack.ack.shareYourself | Send this link to your client yourself; Cleared doesn't email it. For security it is shown only now. | यह लिंक अपने क्लाइंट को ख़ुद भेजें; Cleared इसे ईमेल नहीं करता। सुरक्षा के लिए यह सिर्फ़ अभी दिखाया जा रहा है। |
| pack.ack.shownOnce | Link created {time}; for security the link is shown once. Revoke and create a new one if you lost it. | लिंक {time} पर बना; सुरक्षा के लिए लिंक एक ही बार दिखाया जाता है। खो गया हो तो इसे रद्द करके नया बनाएँ। |
| pack.ack.expires | Expires {date} | {date} को ख़त्म होगा |
| pack.ack.expiresWorkspace | Expires {date}, when this demo workspace ends | {date} को ख़त्म होगा, जब यह डेमो वर्कस्पेस बंद होगा |
| pack.ack.status.pending | Waiting for your client | क्लाइंट के जवाब का इंतज़ार |
| pack.ack.status.accepted | Accepted | स्वीकार किया गया |
| pack.ack.status.expired | Expired | समय ख़त्म |
| pack.ack.status.revoked | Revoked | रद्द किया गया |
| pack.ack.status.scopeChanged | Scope changed | दायरा बदल गया |
| pack.ack.acceptedAt | Accepted {time} {tz} | {time} {tz} पर स्वीकार किया गया |
| pack.ack.inEvidence | Recorded as client sign-off in Evidence. | सबूत में क्लाइंट की मंज़ूरी के रूप में दर्ज। |
| pack.ack.viewEvidence | View in evidence | सबूत में देखें |
| pack.ack.earlierScope | for an earlier version of the scope | दायरे के पिछले रूप के लिए |
| pack.ack.expiredBody | This link expired on {date} without a reply. | यह लिंक {date} को बिना जवाब के ख़त्म हो गया। |
| pack.ack.revokedBody | You revoked this link on {date}. | आपने यह लिंक {date} को रद्द किया। |
| pack.ack.scopeChanged | The scope changed after you created this link, so the link no longer works. | लिंक बनाने के बाद दायरा बदल गया, इसलिए यह लिंक अब काम नहीं करता। |
| pack.ack.revoke | Revoke link | लिंक रद्द करें |
| pack.ack.revokeConfirm | Revoke this link? Your client won't be able to use it. | यह लिंक रद्द करें? आपका क्लाइंट इसका इस्तेमाल नहीं कर पाएगा। |
| pack.ack.revokeYes / keep | Revoke / Keep link | रद्द करें / लिंक रहने दें |
| pack.ack.announceAccepted | Your client confirmed the scope. | आपके क्लाइंट ने दायरे की पुष्टि कर दी। |
| pack.ack.createError / revokeError | Couldn't create the link. / Couldn't revoke the link. | लिंक नहीं बन सका। / लिंक रद्द नहीं हो सका। |
| pack.ack.offline | You're offline. Links can be changed when you reconnect. | आप ऑफ़लाइन हैं। दोबारा जुड़ने पर लिंक बदले जा सकते हैं। |
| pack.list.ackBy | Confirmed by {name}, {time} | {name} ने {time} पर पुष्टि की |
| pack.list.ackMeta | IP {ip} · {browser} | IP {ip} · {browser} |
| pack.list.ackScope | Scope fingerprint {short} | दायरे का फ़िंगरप्रिंट {short} |
| pack.list.ackSource | Recorded by Cleared from the client's link | क्लाइंट के लिंक से Cleared ने दर्ज किया |
| ack.metaTitle | Confirm the agreed work · Cleared | तय काम की पुष्टि · Cleared |
| ack.title | Confirm the agreed work | तय काम की पुष्टि करें |
| ack.sellerFallback | The seller | विक्रेता |
| ack.from | {seller} asks you to confirm the work you agreed for this payment. | {seller} आपसे इस भुगतान के लिए तय काम की पुष्टि करने को कह रहे हैं। |
| ack.scopeHeading | What was agreed | क्या तय हुआ था |
| ack.name | Your name | आपका नाम |
| ack.nameHint | As you would sign it. | जैसे आप हस्ताक्षर करते हैं। |
| ack.agree | I agree to this scope | मैं इस दायरे से सहमत हूँ |
| ack.recorded | When you confirm, Cleared records your name, the time, your IP address and your browser. {seller} can see this record, and it may be sent to PayPal as evidence for this payment. | पुष्टि करने पर Cleared आपका नाम, समय, आपका IP पता और ब्राउज़र दर्ज करता है। {seller} यह रिकॉर्ड देख सकते हैं, और इसे इस भुगतान के सबूत के रूप में PayPal को भेजा जा सकता है। |
| ack.confirm / confirming | Confirm / Confirming… | पुष्टि करें / पुष्टि हो रही है… |
| ack.error.nameRequired | Enter your name. | अपना नाम लिखें। |
| ack.error.nameTooLong | Use 120 characters or fewer. | 120 या उससे कम अक्षर इस्तेमाल करें। |
| ack.error.agreeRequired | Tick the box to confirm you agree. | सहमति की पुष्टि के लिए बॉक्स पर टिक करें। |
| ack.success | Thanks, {name}. Your confirmation is recorded. | धन्यवाद, {name}। आपकी पुष्टि दर्ज हो गई है। |
| ack.recordedAt | Recorded {time} | {time} पर दर्ज |
| ack.successClose | You can close this page. This link won't open again. | आप यह पेज बंद कर सकते हैं। यह लिंक दोबारा नहीं खुलेगा। |
| ack.rateLimited | Too many attempts. Try again in a few minutes. | बहुत ज़्यादा कोशिशें हुईं। कुछ मिनट बाद फिर कोशिश करें। |
| ack.neutralTitle | This link can't be used | यह लिंक इस्तेमाल नहीं हो सकता |
| ack.neutralBody | Ask the person who sent it for a new one. | जिसने इसे भेजा है, उनसे नया लिंक माँगें। |
| ack.errorTitle / errorBody | Couldn't record your confirmation. / Your answer wasn't saved. Try again. | आपकी पुष्टि दर्ज नहीं हो सकी। / आपका जवाब सेव नहीं हुआ। फिर कोशिश करें। |
| ack.noscript | Turn on JavaScript to confirm. | पुष्टि करने के लिए JavaScript चालू करें। |
| ack.footer | Cleared records this confirmation for the seller. PayPal sandbox demo. | Cleared यह पुष्टि विक्रेता के लिए दर्ज करता है। PayPal सैंडबॉक्स डेमो। |

Copy rules: never say the confirmation "proves", "guarantees" or "protects" anything; it is evidence the seller may send to PayPal. Example data (synthetic): seller "Ravi Menon Design", $120.00 USD, scope "Three logo concepts and two rounds of revisions. Final files as SVG and PNG."
