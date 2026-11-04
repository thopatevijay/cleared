# Owner spot-check (M4-01)

**Not performed (owner decision 2026-11-04, #45).** The owner didn't do this check; the labels are unreviewed by a human apart from ext-004.

Claude (`claude-opus-5-5`) labelled the gold sets (owner decision 2026-11-04, #45). This file is the
owner's check on those labels: 5 test items, picked at random, with every label Claude gave.

**How the 5 were picked:** every `test` item labelled by Claude (68), sorted by
`sha256("cleared-spotcheck-v1:" + item id)`, first 5. Re-running the pick gives the same 5:
`hold-02-en`, `hold-03-hi`, `ext-024`, `scope-013`, `scope-036`.

**What the labels mean**

- **met**: the documents clearly show it.
- **partial**: only part of it is shown (for example 1 of 2 things delivered).
- **missing**: the documents show it is not there, or say the opposite.
- **unverifiable**: the documents don't say either way.

The quote is copied exactly from a document. The documents below are trimmed to the lines that matter;
the full text is in `gold/<set>.jsonl`. All names, amounts and ids are invented.

**What to do:** for each statement, read the lines and Claude's label, then fill in the "Owner" line
with `agree` or `disagree` and a short comment if you disagree. That's the only owner step left.

---

## 1. hold-02-en: payment hold under review (English)

A Kenyan web designer asks: *"Why is my repeat client's $85 website-build deposit on hold?"* Holds items
are judged only against PayPal's data and PayPal's own rule text, never the seller's question.

**Documents (trimmed)**

- D1, PayPal's record of the payment: `"status": "PENDING"`, `"reason": "PENDING_REVIEW"`, amount USD 85.00
- D2, PayPal rule T2105: "A payment review hold protects against unauthorized fraud loss and for seller
  protection. PayPal reviews the transaction for up to 24 hours."
- D3, PayPal Holds panel: "We're taking a closer look at this payment. It's required for some payments and
  normally takes up to 3 business days. Don't ship until we tell you it's ok."

**H1.** The payment is pending, with the reason listed as pending review.
- Claude: **met**. Quotes: `"status": "PENDING"` and `"reason": "PENDING_REVIEW"` (D1)
- Why: PayPal's record shows status PENDING with reason PENDING_REVIEW.
- Owner: agree / disagree + comment:

**H2.** A payment review hold protects against unauthorized fraud loss and provides seller protection.
- Claude: **met**. Quote: "protects against unauthorized fraud loss and for seller protection" (D2)
- Why: PayPal's rule text gives exactly this purpose.
- Owner: agree / disagree + comment:

**H3.** The payment review rule says PayPal reviews the transaction for up to 24 hours; the Holds panel
says a closer look normally takes up to 3 business days.
- Claude: **met**. Quotes: "PayPal reviews the transaction for up to 24 hours." (D2) and "normally takes
  up to 3 business days" (D3)
- Why: both time frames are stated, one in each PayPal source.
- Owner: agree / disagree + comment:

**H4.** PayPal guarantees that the payment will be released after the review. *(A claim a good answer must
not make.)*
- Claude: **missing**. Quote: "Don't ship until we tell you it's ok." (D3)
- Why: no source promises release; PayPal is still checking for fraud and says not to ship yet, so the
  outcome is open.
- The second model said *unverifiable* (the sources don't mention a guarantee at all). Claude kept
  *missing*: an open fraud review contradicts a guarantee. Both mean "not supported".
- Owner: agree / disagree + comment:

---

## 2. hold-03-hi: payment hold after a buyer complaint (Hinglish)

A Nigerian seller of brass home decor asks (in Hinglish): *"Why is my €132.50 payment pending?"*

**Documents (trimmed)**

- D1, PayPal's record of the payment: `"status": "PENDING"`, `"reason": "BUYER_COMPLAINT"`, `"value": "132.50"` (EUR)
- D2, PayPal rule T1110: "T1110 Hold on balance for dispute investigation: Hold to cover possible
  chargeback."

**H1.** €132.50 ka payment pending hai. *(The €132.50 payment is pending.)*
- Claude: **met**. Quotes: `"status": "PENDING"` and `"value": "132.50"` (D1)
- Why: PayPal's record shows status PENDING for EUR 132.50.
- Owner: agree / disagree + comment:

**H2.** Pending status ki wajah buyer complaint hai. *(The reason for the pending status is a buyer
complaint.)*
- Claude: **met**. Quote: `"reason": "BUYER_COMPLAINT"` (D1)
- Why: the record's reason is BUYER_COMPLAINT.
- Owner: agree / disagree + comment:

**H3.** Dispute investigation hold ek possible chargeback ko cover karta hai. *(The dispute investigation
hold covers a possible chargeback.)*
- Claude: **met**. Quote: "T1110 Hold on balance for dispute investigation: Hold to cover possible
  chargeback." (D2)
- Why: PayPal's rule says exactly this.
- Owner: agree / disagree + comment:

**H4.** Payment release hona guaranteed hai. *(The payment is guaranteed to be released. A claim a good
answer must not make.)*
- Claude: **missing**. Quote: the same T1110 line (D2)
- Why: the money is held in case the buyer's bank takes it back (a chargeback), so release is not
  guaranteed.
- The second model said *unverifiable*. Claude kept *missing*: "hold to cover possible chargeback" says
  the money may not come back.
- Owner: agree / disagree + comment:

---

## 3. ext-024: facts from a children's book illustration order

An Indonesian illustrator's order. Extraction items check that each fact can be found in the documents.

**Documents (trimmed)**

- D1, the buyer's brief: "Buyer: Nara Velin" / "Seller: Suri Kelana, Indonesia" / "Deliver the final
  artwork as six separate high-resolution PNG files." / "We agreed on a total fee of JPY 48,000."
- D2, chat: "Can you deliver the final PNGs by 28 March 2025?" / "Yes, I'll deliver them by then, …"
- D3, invoice: "Total due: JPY 48,000" / "Final files are scheduled for delivery by 28 March 2025, subject
  to timely feedback on sketches."
- No document mentions a publisher.

**H1.** Amount: JPY 48,000
- Claude: **met**. Quote: "Total due: JPY 48,000" (D3)
- Why: the invoice total and the agreed fee are both JPY 48,000.
- Owner: agree / disagree + comment:

**H2.** Deliverable: six separate high-resolution PNG files
- Claude: **met**. Quote: "six separate high-resolution PNG files" (D1)
- Why: the brief asks for exactly this.
- Owner: agree / disagree + comment:

**H3.** Date: 28 March 2025
- Claude: **met**. Quote: "scheduled for delivery by 28 March 2025" (D3)
- Why: the chat and the invoice both give 28 March 2025 as the delivery date.
- Owner: agree / disagree + comment:

**H4.** Party: Suri Kelana
- Claude: **met**. Quote: "Seller: Suri Kelana" (D1)
- Why: Suri Kelana is the illustrator (the seller).
- Owner: agree / disagree + comment:

**H5.** Party: publisher of The Lantern Mouse
- Claude: **unverifiable** (no quote)
- Why: no document mentions a publisher.
- Owner: agree / disagree + comment:

---

## 4. scope-013: children's book illustrations, what was delivered

An Indian illustrator agreed 4 things. Scope items check each agreed line against the delivery evidence.

**Documents (trimmed)**

- D1, agreed scope: (1) six full-color interior illustrations as print-ready PNG files; (2) one full-color
  front cover as a print-ready PNG; (3) character sheets for both Momo the cloud and Pip the sparrow;
  (4) a black-and-white coloring page featuring Momo and Pip. "Print-ready files should be 300 dpi."
- D2, handover note: "interior-01.png through interior-06.png: six full-color interior illustrations, 300
  dpi." / "front-cover.png: full-color front cover illustration, 300 dpi." / "momo-character-sheet.pdf:
  Momo's character sheet." / "Pip's character sheet is not included. The black-and-white coloring page is
  also not included."
- D3, chat: "The six interior PNGs and the front cover open properly" / "Pip's sheet and the coloring page
  are missing from the folder." / "I haven't delivered either of those yet."

**H1.** Deliver six full-color interior illustrations as print-ready PNG files.
- Claude: **met**. Quote: "interior-01.png through interior-06.png: six full-color interior illustrations,
  300 dpi." (D2)
- Why: six 300 dpi interior PNGs were delivered and the buyer says they open.
- Owner: agree / disagree + comment:

**H2.** Deliver one full-color front cover illustration as a print-ready PNG file.
- Claude: **met**. Quote: "front-cover.png: full-color front cover illustration, 300 dpi." (D2)
- Why: the cover PNG at 300 dpi was delivered and opens.
- Owner: agree / disagree + comment:

**H3.** Deliver character sheets for both Momo the cloud and Pip the sparrow.
- Claude: **partial**. Quotes: "momo-character-sheet.pdf: Momo's character sheet." and "Pip's character
  sheet is not included." (D2)
- Why: Momo's sheet was delivered, Pip's was not: one of two.
- Owner: agree / disagree + comment:

**H4.** Deliver a black-and-white coloring page featuring Momo and Pip.
- Claude: **missing**. Quote: "The black-and-white coloring page is also not included." (D2)
- Why: the seller says it was not delivered, and the buyer confirms.
- Owner: agree / disagree + comment:

---

## 5. scope-036: woven sisal baskets, what was delivered

An Indonesian basket maker agreed 4 things with a buyer in Japan.

**Documents (trimmed)**

- D1, agreed scope: four woven sisal baskets; natural, undyed sisal; one cotton liner in each basket; a
  care card attached to each basket.
- D2, delivery note: "Four woven sisal baskets, nested for transport." / "Material recorded at packing:
  natural, undyed sisal." / "No cotton liners packed." / "The packing record does not list care cards."
- D3, chat: "I counted four baskets, and the sisal is natural and undyed as agreed." / "there were no
  cotton liners in the parcel or inside the baskets." / "Sorry, I left the liners out when packing." /
  "I haven't checked the wrapping for the care cards yet, so I can't confirm those."

**H1.** Supply four woven sisal baskets.
- Claude: **met**. Quote: "I counted four baskets" (D3)
- Why: four baskets were packed and the buyer counted four on arrival.
- Owner: agree / disagree + comment:

**H2.** Use natural, undyed sisal for the baskets.
- Claude: **met**. Quote: "the sisal is natural and undyed as agreed" (D3)
- Why: the packing record and the buyer both confirm it.
- Owner: agree / disagree + comment:

**H3.** Include one cotton liner in each basket.
- Claude: **missing**. Quote: "No cotton liners packed." (D2)
- Why: no liners were packed at all; the seller admits leaving them out.
- The second model said *partial*. Claude kept *missing*: none of the liners arrived.
- Owner: agree / disagree + comment:

**H4.** Attach a care card to each basket.
- Claude: **unverifiable** (no quote)
- Why: the packing record doesn't list care cards and the buyer hasn't checked yet, so nobody knows.
- Owner: agree / disagree + comment:
