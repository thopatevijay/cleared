# Carrier lists: provenance (M3-03)

| File | What it is | Source | Date |
|---|---|---|---|
| `api-carriers.json` | PayPal's tracking API carrier enum: code, name, country | https://developer.paypal.com/docs/tracking/reference/carriers/ (parsed from the page's tables) | 2026-11-02 |
| `shipped-by-dropdown.json` | The codes of the "Shipped by" list in Add Tracking Info (the `approved` tier) | PayPal sandbox Business web UI, US sandbox business account | 2026-11-02 |
| `shipped-by-dropdown.capture.tsv` | The raw capture behind `shipped-by-dropdown.json`: one `code<TAB>label` line per option, in the UI's order | as above | 2026-11-02 |

## "Shipped by" capture (P-51, 2026-11-02)

- **Where.** sandbox.paypal.com, signed in by the owner as the project's US sandbox Business account:
  Activity > a completed payment (`31K84398LX523430F`) > Add Tracking Info > the carrier field
  (placeholder "Search carrier"). Nothing was saved; the tab was closed without submitting.
- **How.** claude-in-chrome, read only: after focusing the field, every `[role=option]` element was read
  for its `data-value` (the code) and `primarytext` (the label). The list is one group ("Other
  Carriers"); all 834 options were in the DOM at once (scrolling to the end added none), with no
  duplicates. The last option is `OTHER` ("Couldn't find your carrier ? Enter your carrier name").
- **Integrity.** The TSV was copied out in chunks and checked against SHA-256 hashes computed in the
  page: all lines (no trailing newline) `c2de08c602c25f26bda545bdf441d73dcec224811d70d23cf965d19d29a71a2f`;
  the codes only, newline-joined, `4aea95aace67769c5fb3abad5086dc5a111482bc59f9294bfcde17fd833fff7c`.
  Three labels keep the trailing space the UI has (`ALPHAFAST`, `APG`, `NATIONWIDE_MY`).
- **Count.** 834, including `OTHER`: the same total the research note saw on 2026-10-26. All 23 codes of
  the earlier partial file are in it.
- **Not in the API list.** 9 dropdown codes are not on the developer page (checked again on 2026-11-02 by
  searching the page HTML): `_2EBOX`, `_360LION`, `_3JMSLOGISTICS`, `_4_72`, `_6LS`, `BEL_DHL`,
  `GLS_ITALY`, `JITSU`, `SKYEXPRESS_INTERNATIONAL`. The page has `SKYEXPRESSINTERNATIONAL` (same name,
  "SkyExpress Internationals") but none of the other eight, under any code or name. The capture is kept
  as recorded; see the M3-03 follow-up PR for how this is resolved.
