# Screen: landing and sign-in

Route `/[locale]` (+ `/[locale]/check-email`, and `/[locale]/signin/expired` as the target of a failed `GET /api/auth/verify`). Built by **M1-07** on the M1-05 routes (`POST /api/demo`, `POST /api/auth/magic-link`).

## Purpose
- For the **judge**: explain the product in one screen and reach a working sandbox workspace in one tap, with no keys and no account.
- For the **seller**: sign in with an email magic link, with no password.

The page states plainly what is real (PayPal sandbox calls) and what is synthetic (buyers, chats, files).

## Layout
Content order (the same at every width):
1. Header: the wordmark "Cleared" (text, Atkinson 700) and `LanguageSwitch`.
2. `<h1>`: "Get your held PayPal money moving, with proof ready before PayPal asks."
3. A one-paragraph explanation (≤ 45 words): "Cleared is an AI agent for small cross-border sellers. It builds a proof pack for every payment, explains holds with PayPal's own rules, and drafts dispute replies from that proof. It never sends anything to PayPal without your approval."
4. **"What happens in the demo"**: a real ordered sequence, so the list is numbered: 1 "A real PayPal sandbox payment arrives through a webhook." 2 "Cleared builds its proof pack from synthetic client files." 3 "A sandbox chargeback opens a dispute; you approve the drafted reply." 4 "You press Simulate PayPal's decision (sandbox only) and watch the money get released."
5. Primary button **"Try as demo seller"** (the Sandbox badge sits next to it, because it creates a sandbox workspace) and the note "No PayPal account or keys needed. Workspace lasts until 16 Dec 2026."
6. Separator text "Already a seller?" and the sign-in form: label "Email", an input (`type=email`, `autocomplete=email`, `inputmode=email`) and the secondary button **"Email me a sign-in link"**.
7. "What's real" box (`surface-sunken`): "Real: PayPal sandbox APIs and responses, PayPal's published rules. Synthetic: every person, chat and file in the demo." Plus a link to the GitHub README.
8. Footer: "Sandbox only. Cleared is not affiliated with PayPal."

**375 px:** a single column with 16 px side padding. The h1 is at the `2xl` step (wrapping to 4 lines is fine). The primary button is full width and 48 px high. The demo steps sit above the fold only partly: the button comes **before** the steps (order 1, 2, 3, 5, 4, 6…), so the judge's main action is visible without scrolling at 375 × 667. No horizontal scroll, and nothing clipped in HI.

**768 px:** a single column, max 640 px, centred block with left-aligned text. The steps show in full above the button.

**1440 px:** two columns in a 1200 px container. Left (7/12): h1 at the `money` step, the paragraph, the demo steps and the primary button. Right (5/12): the sign-in form and the "What's real" box. No hero image or gradient: the type carries the page.

**Light and dark:** both from tokens. The wordmark is text, so it needs no image variant.

## Components
`LanguageSwitch`, primary button, `SandboxBadge`, a text input with a label, secondary button, `ErrorPanel` (inline variant), `Toast` (none here), and a field error (`danger` text + `circle-x` icon).

## States
| State | Trigger | What shows |
|---|---|---|
| Default | — | As in Layout |
| Creating demo | Tap "Try as demo seller" | The button is busy with "Creating your workspace…"; on 201 → redirect to `/payments` (empty state) |
| Cap reached | `POST /api/demo` → 429 | Inline panel (`held` colours, `hourglass` icon): "The demo is busy right now. Try again in {minutes} minutes." (from `Retry-After`). If it's the per-IP cap: "This network has made 3 demo workspaces today. Try again tomorrow, or watch the video." with a link to the video. The reference ID is shown |
| Sending link | Submit the form | The button shows "Sending…" |
| Check email | 200 (always identical, whether or not the email exists) | Replaces the form: icon `mail`, h2 "Check your email", "If {email} can sign in, a link is on its way. It works once and expires in 15 minutes.", the secondary "Use a different email", and "Didn't get it? Send again" (disabled for 60 s with a visible countdown) |
| Invalid email | Client- or server-side zod failure | A field error under the input: "Enter an email like name@example.com"; `aria-invalid`; focus stays in the field |
| Too many requests | 429 on the magic link | "Too many sign-in requests. Try again in {minutes} minutes." Reference shown |
| Expired / used link | Verify → 400 | Route `/signin/expired`: h1 "This sign-in link has expired or was already used", "Links work once, for 15 minutes.", and the form pre-filled if the email is known from the query, otherwise empty. Plus "Try as demo seller" as an alternative |
| Error | 5xx or network | `ErrorPanel` inline: "Couldn't reach Cleared. Check your connection and try again." Retry + Reference |
| Offline | `navigator.onLine === false` | Both buttons are disabled with "You're offline. Connect to try the demo or sign in." |
| Loading | First paint | The page is server-rendered with no skeleton. Fonts swap in without layout shift (size-adjusted fallback) |

There is no "empty" or "partial" data state on this page: it holds no workspace data.

## Interactions
- "Try as demo seller" calls `POST /api/demo` with an `Idempotency-Key`, so a double tap creates one workspace.
- The form submits on Enter. The button and the field are disabled while sending.
- After "Check your email", focus moves to the h2 "Check your email".
- The language switch keeps the form content (the URL locale changes; the field value persists in `sessionStorage`).
- Keyboard path: Skip link "Skip to main content" → language switch (EN, हिं) → "Try as demo seller" → Email field → "Email me a sign-in link" → README link → footer links. On the check-email state: h2 (programmatic focus) → "Use a different email" → "Send again".

## Copy
| Key | EN | HI |
|---|---|---|
| h1 | Get your held PayPal money moving, with proof ready before PayPal asks. | अपना रुका हुआ PayPal पैसा आगे बढ़ाएँ, PayPal के पूछने से पहले सबूत तैयार रखें। |
| intro | Cleared is an AI agent for small cross-border sellers. It builds a proof pack for every payment, explains holds with PayPal's own rules, and drafts dispute replies from that proof. It never sends anything to PayPal without your approval. | Cleared छोटे अंतरराष्ट्रीय विक्रेताओं के लिए एक AI एजेंट है। यह हर भुगतान का सबूत पैक बनाता है, PayPal के अपने नियमों से रोक का कारण समझाता है और उसी सबूत से विवाद का जवाब तैयार करता है। आपकी मंज़ूरी के बिना यह PayPal को कुछ नहीं भेजता। |
| demo.cta | Try as demo seller | डेमो विक्रेता के रूप में आज़माएँ |
| demo.note | No PayPal account or keys needed. Workspace lasts until 16 Dec 2026. | PayPal खाते या key की ज़रूरत नहीं। वर्कस्पेस 16 दिसं॰ 2026 तक चलेगा। |
| demo.step4 | Press "Simulate PayPal's decision (sandbox only)" and watch the money get released. | "Simulate PayPal's decision (sandbox only)" दबाएँ और पैसा रिलीज़ होते देखें। |
| signin.label | Email | ईमेल |
| signin.cta | Email me a sign-in link | मुझे साइन-इन लिंक ईमेल करें |
| check.title | Check your email | अपना ईमेल देखें |
| check.body | If {email} can sign in, a link is on its way. It works once and expires in 15 minutes. | अगर {email} से साइन-इन हो सकता है, तो लिंक भेजा जा रहा है। यह एक बार चलेगा और 15 मिनट में समाप्त हो जाएगा। |
| expired.title | This sign-in link has expired or was already used | यह साइन-इन लिंक समाप्त हो गया है या पहले ही इस्तेमाल हो चुका है |
| cap.busy | The demo is busy right now. Try again in {minutes} minutes. | डेमो अभी व्यस्त है। {minutes} मिनट बाद फिर कोशिश करें। |
| cap.ip | This network has made 3 demo workspaces today. Try again tomorrow, or watch the video. | इस नेटवर्क से आज 3 डेमो वर्कस्पेस बन चुके हैं। कल फिर कोशिश करें, या वीडियो देखें। |
| real | Real: PayPal sandbox APIs and responses, PayPal's published rules. Synthetic: every person, chat and file in the demo. | असली: PayPal सैंडबॉक्स API और उनके जवाब, PayPal के प्रकाशित नियम। काल्पनिक: डेमो के सभी लोग, चैट और फ़ाइलें। |
| footer | Sandbox only. Cleared is not affiliated with PayPal. | सिर्फ़ सैंडबॉक्स। Cleared का PayPal से कोई संबंध नहीं है। |

The sandbox control name "Simulate PayPal's decision (sandbox only)" stays in English in HI, so it matches the button on the dispute screen.

## Accessibility
- One `<h1>`, and `<ol>` for the demo steps. The form has a visible `<label>`, and errors are linked with `aria-describedby` and announced with `role="alert"` once.
- The check-email swap is announced by moving focus to its heading. The countdown on "Send again" is not live-announced each second: the button text is "Send again in 45 s", and the accessible description updates only at 0.
- 375 px: buttons are full width and ≥ 48 px high; the input is 48 px high with a 16 px font (no iOS zoom).
- Contrast pairs used: `text`/`bg`, `text-muted`/`bg`, `on-accent`/`accent`, `border-strong`/`surface` (input boundary), `danger`/`bg` (field error), and `focus` on `bg`.
- `lang` attributes: the page follows the locale. The English sandbox control name inside HI copy is wrapped in `<span lang="en">`.
