# M0-01 · Outreach drafts

Drafted 2026-10-29 on the M0-01 branch. The drafts are private from day one: they live under `docs/outreach/` (gitignored, never tracked) and the owner sends every message. This file records what exists and the gate result, not the message text.

## Drafts

| Draft (gitignored) | Channel | Ask | If the answer is no |
|---|---|---|---|
| `docs/outreach/bryntum-permission-email.md` | email to sales@bryntum.com | written OK to show the Calendar trial (7.3.8) in a public judge demo until 2026-12-15; is the watermark fine; is there a **hackathon arrangement** (extended trial or temporary licence) for entrants. Answer by 2026-11-04 | FullCalendar fallback behind `CashCalendar` (M3-05); only the Bryntum sponsor prize is lost |
| `docs/outreach/bryntum-discord.md` | PayPal Discord #bryntum | the same three questions, 980 characters | same |
| `docs/outreach/paypal-discord-transaction-search.md` | PayPal Discord developer help channel | **optional now**: "a fresh app fixed it; is that the expected fix, or does enabling the feature on an existing app propagate?" 978 characters | nothing changes: we use the fresh app (P-21) |
| `docs/outreach/organisers-sandbox-only.md` | Devpost forum (or the organiser channel on Discord) | yes/no: is a sandbox-only build with one labelled "Simulate PayPal's decision (sandbox only)" step a functional demo | ask what they'd accept; until then the step stays labelled and is described plainly in the README, Devpost text and video |

## Transaction Search: the fact changed before sending

| Fact | Source |
|---|---|
| Old sandbox app: feature ticked and saved; the scope `https://uri.paypal.com/services/reporting/search/read` never appeared in 19 token polls over 3 h; `GET /v1/reporting/balances` → 403 `NOT_AUTHORIZED` (debug_id `f738253865995`) | research spike, 2026-10-26 |
| Fresh sandbox app from M0-00 (P-21): the token **carries** the scope | `check-prereqs.py --only P-22` (local workflow script), 2026-10-29 |
| Not yet measured: a 200 from `/v1/reporting/balances` or `/v1/reporting/transactions` on the fresh app | no PayPal call in M0-01; M0-04 / M3-09 measure it |

The ticket's ask ("expected propagation time, or a known fix") is answered on our side by the fresh app, so that draft became a confirmation question the owner may skip.

## Validation Gate (verbatim, 2026-10-29)

```
docs/outreach/bryntum-discord.md
docs/outreach/bryntum-permission-email.md
docs/outreach/organisers-sandbox-only.md
docs/outreach/paypal-discord-transaction-search.md
ignored docs/outreach/bryntum-discord.md
ignored docs/outreach/bryntum-permission-email.md
ignored docs/outreach/organisers-sandbox-only.md
ignored docs/outreach/paypal-discord-transaction-search.md
       0
     980
     978
       0
check-no-secrets: ok
```

## Owner actions still open (P-50)

- Send the messages; comment on #3 with the date/time and channel of each
- Record each answer (or "no answer by <date>") on #3, tick the matching box in the project spec, and record the Bryntum decision on M3-05 by 2026-11-04
