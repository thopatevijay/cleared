---
title: "M0-01 · Questions to Bryntum (licence) and the organisers (sandbox-only, Transaction Search scope): owner sends, worker drafts"
milestone: "M0 · Recon & Bootstrap"
labels: ["owner", "recon"]
blocked_by: ["M0-00"]
estimate: "1h"
resources: []
needs: []
---

## Context

Three open questions in `PROJECT.md` §1 can change the build or the prize targets:

1. **Bryntum:** the trial EULA allows "solely ... internal evaluation and review purposes". The cash
   calendar is a public, judge-facing demo until 2026-12-15. Without written permission we use the
   FullCalendar fallback behind `CashCalendar` and lose only the Bryntum sponsor prize. Decision
   date **2026-11-04**.
2. **PayPal Transaction Search scope:** missing from the sandbox token even after the owner enabled
   it (19 polls over 3 h, research spike). Without it Cleared can't see payments made outside its own
   app (documented launch limit).
3. **Organisers:** is a sandbox-only build with a clearly labelled "Simulate PayPal's decision
   (sandbox only)" step acceptable as a functional demo (Stage One pass/fail)?

The owner sends every message from their own accounts. A worker only drafts.

## Scope

Worker (drafts only, nothing sent):
- `docs/outreach/bryntum-permission-email.md`: to **sales@bryntum.com**. Who we are (solo PayPal AI
  Hackathon entrant), what we use (one Calendar view, `@bryntum/calendar` trial 7.3.8, React 19 /
  Next 16), where (public hosted demo for judges, 2026-11-12 to 2026-12-15, no commercial use),
  the ask (written OK to show the trial build publicly until 2026-12-15, and whether the trial
  watermark is acceptable to them for the sponsor prize), and the date we need an answer by (2026-11-04)
- `docs/outreach/bryntum-discord.md`: the same ask, short, for the **PayPal Discord #bryntum** channel (≤ 2000 characters)
- `docs/outreach/paypal-discord-transaction-search.md`: for the PayPal Discord help channel. Facts
  only: sandbox REST app, Transaction Search ticked and saved, token scopes lack
  `https://uri.paypal.com/services/reporting/search/read`, `GET /v1/reporting/balances` → 403
  NOT_AUTHORIZED (quote the debug_id from the research spike), fresh app tried or not (from M0-00).
  Ask: expected propagation time, or a known fix. No credentials, no client ID
- `docs/outreach/organisers-sandbox-only.md`: for the Devpost forum / organiser channel: sandbox-only
  build, real sandbox API calls throughout, one labelled sandbox-only decision step (adjudicate), a
  hosted demo URL with no keys needed. Ask for a yes/no
- Each draft states the channel, the exact text, and a "what we do if the answer is no" line

Owner:
- Sends the four messages; comments on this issue with the date/time sent and the channel
- Records each answer (or "no answer by <date>") on this issue and ticks the matching box in
  `PROJECT.md` §1 open questions

## Out of scope

- Starting the Bryntum trial or the Bryntum spike (M0-09)
- Creating a new sandbox app (owner action listed in M0-00)
- Implementing the FullCalendar fallback (M3-05 behind `CashCalendar`)

## Acceptance Criteria

- [ ] Four drafts exist under `docs/outreach/` and are **gitignored** (never tracked)
- [ ] Each Discord draft is ≤ 2000 characters; none contains a secret, client ID, email address of a sandbox account, or token
- [ ] Each draft names its channel and a fallback if the answer is no
- [ ] The owner's "sent" comment is on this issue for all four (date, channel)
- [ ] Answers (or "no answer yet") recorded on this issue; the Bryntum decision recorded by 2026-11-04 on M3-05

## Deliverables

- `docs/outreach/bryntum-permission-email.md`, `docs/outreach/bryntum-discord.md`,
  `docs/outreach/paypal-discord-transaction-search.md`, `docs/outreach/organisers-sandbox-only.md` (all gitignored)
- Issue comments: sent log, answers

## Validation Gate

```bash
ls docs/outreach/{bryntum-permission-email,bryntum-discord,paypal-discord-transaction-search,organisers-sandbox-only}.md
for f in docs/outreach/*.md; do git check-ignore -q "$f" && echo "ignored $f" || { echo "TRACKABLE $f"; exit 1; }; done
git ls-files docs/outreach | wc -l                                  # expect 0
for f in docs/outreach/bryntum-discord.md docs/outreach/paypal-discord-transaction-search.md; do
  awk '/^```/{f=!f;next} f' "$f" | wc -c                            # message body; expect <= 2000
done
grep -rnE '(client_id|client_secret|Bearer |A21AA|sk-)' docs/outreach/ | wc -l   # expect 0
./scripts/check-no-secrets.sh
```

## Handoff

- **M0-09 / M3-05:** the Bryntum answer (or none by 2026-11-04 → FullCalendar behind `CashCalendar`)
- **M3-09 / M5-01:** the Transaction Search answer (scope arrives → back-fill; otherwise the documented launch limit stays in README and `PROJECT.md` §9)
- **M2-10 / M5-01 / M5-03:** the organisers' answer on the labelled sandbox decision step (wording in the README and Devpost text)
- **M0-GATE:** the "sent" comments exist on this issue
