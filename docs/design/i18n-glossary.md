# Hindi glossary (M4-03)

`apps/web/messages/hi.json` follows this glossary, and so do the email templates (`packages/core/src/notifications/templates/hi.ts`) and the scope snapshot's Hindi labels (`SCOPE_SNAPSHOT_LABELS`). It complements README "Writing": write natural Hindi rather than a word-for-word translation. Keep digits Latin, and keep PayPal's terms recognisable, so a seller can match what Cleared says with what PayPal's own pages and emails say, which are in English.

`pnpm i18n:check` keeps `en.json` and `hi.json` aligned: the same keys, no empty values, and the same ICU placeholders in each pair.

## Rules

1. **PayPal terms keep the English word in brackets on first use per screen.** Their first appearance on a screen, usually the `h1`, reads "रोका गया पैसा (hold)" or "{amount} पर विवाद (dispute)". After that, the Hindi word stands alone on that screen.
2. **PayPal's codes, states and IDs stay in Latin script and are never translated:** `PENDING`, `PENDING_REVIEW`, `BUYER_COMPLAINT`, `COMPLETED`, `RESOLVED_WITH_PAYOUT`, capture and dispute IDs, `debug_id`, and carrier codes. They sit in a `<code lang="en">` element.
3. **Product and brand names stay in Latin:** PayPal, Cleared, Bryntum.
4. **Digits are Latin** (`numberingSystem: latn`). Amounts use the Indian grouping in HI ("₹12,34,567.89"). The ISO currency code always follows the amount.
5. **Times use the 24-hour clock in HI** ("22:30 IST"). Latin "am/pm" never appears inside Devanagari text.
6. **What goes to PayPal stays English.** Dispute notes and evidence are filed in English whatever the UI language, and the review screen says so (`disputes.draft.notesEnglish`). The scope snapshot PDF keeps every English label and adds the Hindi one after it ("Payment · भुगतान").
7. **The sandbox decision control keeps its English label** ("Simulate PayPal's decision (sandbox only)"), as `landing.md` requires.
8. **Address the seller as आप**, and use plain verbs in the imperative for buttons ("सेव करें", "भेजें", "रद्द करें").

## Terms

| English | Hindi (first use on a screen) | Hindi (after that) | Notes |
|---|---|---|---|
| hold, held money | रोका गया पैसा (hold) | रोका गया पैसा, रोक | the status badge "Held" is रोका गया |
| hold released | रोक हटी | रोक हटी | |
| dispute | विवाद (dispute) | विवाद | "In dispute" is विवाद में |
| claim | दावा | दावा | "Accept the claim" is दावा मानें |
| chargeback | चार्जबैक | चार्जबैक | a loanword, written in Devanagari |
| estimated (release date) | अनुमानित | अनुमानित | never promise a date (README rule 2) |
| proof pack | सबूत पैक | सबूत पैक | |
| evidence | सबूत | सबूत | |
| scope (agreed work) | तय दायरा | दायरा | |
| scope snapshot | दायरे का स्नैपशॉट | दायरे का स्नैपशॉट | never "signed" (हस्ताक्षर only in a negation) |
| client acknowledgement | क्लाइंट की पुष्टि | क्लाइंट की पुष्टि | "client" is क्लाइंट, not ग्राहक |
| buyer | खरीदार | खरीदार | |
| seller | विक्रेता | विक्रेता | |
| tracking (number) | ट्रैकिंग | ट्रैकिंग | carrier codes stay Latin |
| approve | मंज़ूर करें | मंज़ूरी | |
| audit log | ऑडिट लॉग | ऑडिट लॉग | |
| Completed (PayPal status) | पूरा हुआ | पूरा हुआ | a PayPal state; keep it distinct from the scope verdict |
| met / partly met (scope verdict) | शर्त पूरी / शर्त आंशिक रूप से पूरी | same | BL-01 6538812163: no longer reads like "Completed" |
| time zone | समय क्षेत्र (time zone) | समय क्षेत्र | |
| sandbox | सैंडबॉक्स | सैंडबॉक्स | always labelled |
| seller keeps the money (PayPal covered the case) | पैसा आपके पास रहेगा (PayPal ने मामला कवर किया) | same | never claim a victory (README rule 1) |
