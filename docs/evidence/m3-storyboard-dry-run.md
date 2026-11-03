# M3-11 · Storyboard dry run on production: evidence

Run 2026-11-03 04:11–04:28 UTC against **production** (`https://cleared-web-gd1b.onrender.com`, Render,
Oregon) with `apps/web/e2e/storyboard.spec.ts` (deployed mode: no local server, no stub, no credential in the
test). Production at run time: **web on `1463670`**, **worker on `f93f88d`**. The web build of `f93f88d`
(#127, cash calendar) fails on Render (see scene 4). Every PayPal call ran on the **PayPal sandbox**. All
personal data is synthetic: the seller is an anonymous "Try as demo seller" workspace, the client is the
scenario's "Northwind Tea Co." and the designer is "Meera Studio" (`fixtures/scenario/`). The ids below are
sandbox ids. No secret values appear here.

| | |
|---|---|
| workspace (demo) | `7228ebdd-647d-45bb-ac6b-e9b46011f463` |
| scenario run | `efa4a827-9550-40b3-8a5b-e0a4305eeebd` |
| order | `3R700212UD562962K` |
| capture ($120.00 USD, card) | `85R37727PK2111840` |
| payment | `eb5c3dc3-9451-49f3-bcac-ee91a898ff95` |
| dispute | `PP-R-XID-10196080` (reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, stage `CHARGEBACK`) |
| evidence filing | `provide_evidence`, fingerprint `a4134f6e`, PayPal **200**, `debug_id f696998b0718a` |

## Scenes

The storyboard column is PROJECT.md §2. "Wall time" is the measured time of the scene in this run. "Source"
is what moved the state Cleared shows: a verified PayPal webhook, or Cleared's own poll / re-fetch.

| Scene | Storyboard | Result | Wall time | Sandbox ids | Source of each state change |
|---|---|---|---|---|---|
| 1 Proof pack: payment arrives, chat + files, AI scope check with quotes, client acknowledgement, scope snapshot | 0:20–0:45 (25 s) | pass | 91 s | order `3R700212UD562962K`, capture `85R37727PK2111840` | payment: **poll** (scenario capture sync, 04:11:44; the `PAYMENT.CAPTURE.COMPLETED` webhook followed at 04:11:46 and was processed idempotently); pack, check, ack, snapshot: Cleared's own jobs |
| 2a Real `PENDING_REVIEW` hold, explained in Hindi with estimate + source | 0:45–1:05 (20 s) | fail | not run | none: the production review-hold pool has 0 rows | n/a. Blocked: no sanctioned route to create the pool on production (BL-01 6575469150; owner action on #43) |
| 2b Route advice + tier badge on a goods order | (same window) | fail | not run | none | n/a. Blocked: no product path makes a goods hold (BL-01 6570499264; owner decision on #43) |
| 3 Dispute lands → `PENDING/BUYER_COMPLAINT`, bell, draft, approval, filing, labelled sandbox decision, `RESOLVED_WITH_PAYOUT`, `COMPLETED` | 1:05–1:50 (45 s) | pass | 14 min 39 s | dispute `PP-R-XID-10196080`, capture `85R37727PK2111840`, `debug_id f696998b0718a` | dispute + hold: **webhook** `CUSTOMER.DISPUTE.CREATED` (04:15:04) → capture re-fetch → `PENDING/BUYER_COMPLAINT` (payment `source = webhook`); dispute steps: **webhook** `CUSTOMER.DISPUTE.UPDATED` ×3; release to `COMPLETED`: **poll** (scenario poll, 04:27:21), then `CUSTOMER.DISPUTE.RESOLVED` webhook (04:27:34) |
| 3 email alert | (same) | fail | n/a | n/a | in-app bell only: demo workspaces get no email by design (M3-08 handoff); an allowlisted owner workspace is needed to show the email |
| 4a Audit log: agent proposal, seller approval | 1:50–2:15 (25 s) | pass | 2 s | `debug_id f696998b0718a` on the "sent" row | Cleared's audit rows |
| 4b Cash calendar: releases and deadlines | (same) | fail | 60 s (timeout) | n/a | `/en/calendar` is **404** on production: the web build of #127 fails on Render (BL-01 6595246110) |
| 5 Guided Completed step on a service payment | n/a | fail | not run | none | Blocked: no product path makes a service hold (BL-01 6570499264). The run stopped at 4b, but no service hold existed in the workspace |

### Scene 1 detail (wall clock from the "Run the dispute scenario" click)

| Step | At | + |
|---|---|---|
| scenario started | 04:11:30 | 0 s |
| capture `COMPLETED` (real sandbox order + capture, `custom_id` = workspace) | 04:11:37 | 7 s |
| pack seeded through the M2-01 intake (scope chat, delivery PDF, acceptance message) | 04:11:39 | 9 s |
| payment visible in the dashboard | 04:11:44 | 14 s |
| seller pasted a client message + uploaded a screenshot on the pack page; AI check finished: 6 lines (`met` ×3, `unverifiable` ×3), 11 verbatim citations | 04:12:35 | 65 s |
| client confirmed the acknowledgement link from a second browser (no session) | 04:12:43 | 73 s |
| scope snapshot PDF created and downloaded (`scope-snapshot-<12 hex>.pdf`) | 04:12:48 | 78 s |

### Scene 3 detail

| Step | At | + from chargeback |
|---|---|---|
| sandbox chargeback created | 04:11:42 | 0 |
| `CUSTOMER.DISPUTE.CREATED` webhook; capture re-fetched as `PENDING / BUYER_COMPLAINT` | 04:15:04 | 3 min 22 s |
| bell: "Notifications, N unread" (dispute_opened), checked right after the dispute was mirrored | 04:15:09+ | ~3 min 27 s |
| evidence step (`WAITING_FOR_SELLER_RESPONSE`) | 04:15:29 | 3 min 47 s |
| agent draft proposed (`provide_evidence`, `PROOF_OF_FULFILLMENT`, notes 621/2000, one compiled PDF 222 KB) | 04:16:14 | 4 min 32 s |
| seller approved (fingerprint `a4134f6e` matched); six checks passed | 04:16:19 | 4 min 37 s |
| evidence filed: PayPal 200, `debug_id f696998b0718a` | 04:16:26 | 4 min 44 s |
| "Simulate PayPal's decision (sandbox only)" enabled and clicked | 04:20:23 | 8 min 41 s |
| dispute `RESOLVED` / `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`; capture `COMPLETED` | 04:27:21–04:27:23 | 15 min 39 s |
| "Hold released: payment is Completed" on the scenario page | 04:27:25 | 15 min 43 s |

The outcome reads "Resolved; you keep the money (PayPal covered the case)". No page contains "won".

## AC checks on production (read-only SQL, `cleared-prod-select`)

```
executions  (workspace 7228ebdd…): 2026-11-03 04:16:20Z  paypal_status 200  paypal_debug_id f696998b0718a  attempt 1
proposed_actions: provide_evidence  succeeded  a4134f6e
disputes: PP-R-XID-10196080  RESOLVED  {"outcome_code":"RESOLVED_WITH_PAYOUT","outcome_reason":"REPRESENTED_BY_PAYPAL",…}
payments: 85R37727PK2111840  COMPLETED  source webhook
review_hold_pool: 0 rows
```

There is no tracking execution: tracking is offered only on a goods hold, and no product path makes one
(BL-01 6570499264). The tracking write itself is proven on the sandbox by M3-03 (201, `debug_id
f81989929c083`), not on production.

## Spend

OpenAI, from `agent_runs` of the run's workspace (the API's token counts, priced by the app): `check_scope` ×2
$0.0172, `draft_dispute` ×2 $0.0082, `extract` ×5 $0.0011, `explain_hold` ×1 $0.0001. **Total $0.0267.**
PayPal sandbox: $0.

## Deltas for M5-02 (timings against the < 3:00 cut)

- **Scene 1 (91 s against 25 s):** the AI check takes ~50 s. Record the paste/upload live and cut to the
  checked verdicts, or stage the payment a few minutes ahead.
- **Scene 3 (14 min 39 s against 45 s):** as §2 plans, stage the chargeback ~20 min ahead. On camera, show
  the held row and bell (the dispute webhook took 3 min 22 s), the approval (filing took 7 s), then cut to
  the decision. The decision to `RESOLVED` took 7 min in this run.
- **Copy:** the UI reads "Resolved; you keep the money (PayPal covered the case)". The storyboard line
  "Resolved: she keeps the $120 (PayPal covered the case)" is the voice-over, not the UI string.
- **Approval:** in this dry run the script clicked Approve as the synthetic demo seller (as M2-10's judge
  spec does). In the recording, the owner clicks it on camera.
- **Email alert:** a demo workspace gets no email. Record scene 3 in the owner's allowlisted workspace to
  show the email.
- Scenes 2, 4b and 5 have no timing yet: they are blocked (above).

## Screenshots

- `m3-storyboard-s1-pack-verdicts.png`: the pack with the verdicts, quotes and the seller's added items
- `m3-storyboard-s1-client-ack.png`: the client's confirmation in the second browser
- `m3-storyboard-s3-evidence-filed.png`: the filing status with PayPal's `debug_id`
- `m3-storyboard-s3-dispute-resolved.png`: the resolved dispute, the outcome and the audit trail
- `m3-storyboard-s3-scenario-resolved.png`: the scenario timeline with the hold released
- `m3-storyboard-s4-audit.png`: the audit log (agent proposal, seller approval, sent with `debug_id`)

## Defects and blockers filed

| What | Where |
|---|---|
| No product path makes a goods or service hold (scenes 2b, 5; tracking half of AC 4) | BL-01 6570499264 (owner decision, options on #43) |
| No production review-hold pool, and no sanctioned route for the build to create one (scene 2a, AC 2) | BL-01 6575469150 (owner action on #43) |
| Render web build of #127 fails (scene 4b; blocks every deploy of web) | BL-01 6595246110, blocker on #37 |
| The draft leaves the seller's later items unselected, including the client's sign-off and the scope snapshot | BL-01 6595501766 (owner M3-06) |
| "Thanks, Northwind Tea Co.. Your confirmation is recorded.": double full stop when the client's name ends in "." | BL-01 6595502129 (owner M4-03) |
