# M3-11 · Storyboard dry run on production: evidence

Two live runs of `apps/web/e2e/storyboard.spec.ts` against **production**
(`https://cleared-web-gd1b.onrender.com`, Render, Oregon), in deployed mode: no local server, no stub,
no credential in the test.
- **Run 1** was on 2026-11-03 at 04:11–04:28 UTC, with web on `1463670` and worker on `f93f88d`.
- **Run 2** was at 06:03–06:18 UTC, with web and worker both on **`c5afc1c`**. That build includes #129 (the
  web build fix) and #130 (the seller's goods/service declaration, option A).

Run 2 is the run of record below. Run 1 is summarised at the end.

Every PayPal call ran on the **PayPal sandbox**. All personal data is synthetic:
- the seller is an anonymous "Try as demo seller" workspace;
- the client is "Northwind Tea Co." and the designer is "Meera Studio", both from the scenario's
  `fixtures/scenario/`;
- the review-hold payment was approved by the sandbox buyer account (P-52).

The ids are sandbox ids. No secret values appear here.

## Staging (run 2)

| Step | When (UTC) | Result |
|---|---|---|
| Video-pool order created on production (`render ssh` on cleared-worker: `node apps/worker/src/cli/pool.ts create --count 1 --purpose video`). A read-only check beforehand found 0 pool rows | 05:52:11 | order `6AE7350594037204V`, 64.00 USD; PayPal create-order 200, `debug_id f282016ddfb16` |
| The owner approved the order as the sandbox buyer (P-52) | before 05:55 | |
| `pool.ts capture` | 05:55:13 | capture POST **201**, `debug_id f230955f1c12e`; capture `63R756703X9265145` **`PENDING / PENDING_REVIEW`** (re-read by GET 200, `debug_id f317634bace8c`); row `held` |
| `pool.ts status` | 05:55 | `video held 6AE7350594037204V 63R756703X9265145 PENDING/PENDING_REVIEW`, expected release `~2026-11-04T05:55Z` (estimated, rule `payment_review`) |
| Web and worker live on `c5afc1c`; `/readyz` `{"ok":true,…}` | 06:03 | |
| Recording workspace created by the spec ("Try as demo seller") | 06:03:35 | `7d178710-e78a-4de8-b437-486e2b346e58` |
| `pool.ts assign --workspace 7d178710…` | ~06:04 | "assigned capture 63R756703X9265145 (order 6AE7350594037204V)" |
| Chargeback (M2-10 scenario, on the $120 card capture) | 06:04 | staged live in the run, not 20 min ahead |

| Run 2 ids | |
|---|---|
| scenario run | `1b3d150a-cece-4eb6-bb01-c93717178bd2` |
| $120 card capture | `0B048240UX508924R` (payment `02a856ac-56ef-4317-9bba-ce75244ddc1c`) |
| dispute | `PP-R-LHX-10196097` (stage `CHARGEBACK`) |
| $64 review-hold capture | `63R756703X9265145` (order `6AE7350594037204V`) |
| tracking (`add_tracking`, IND_DELHIVERY `CLRM311001`, synthetic) | PayPal **201**, `debug_id ca5492f996d63` |
| evidence filing (`provide_evidence`) | PayPal **200**, `debug_id f2295179440e7` |

## Scenes (run 2)

The storyboard column is PROJECT.md §2. "Wall time" is what the scene took in this run. "Source" is what
moved the state Cleared shows: a verified PayPal webhook, or Cleared's own poll / re-fetch.

| Scene | Storyboard | Result | Wall time | Sandbox ids | Source of each state change |
|---|---|---|---|---|---|
| 1 Proof pack: payment arrives, chat + files, AI scope check with quotes, client acknowledgement, scope snapshot | 0:20–0:45 (25 s) | pass | 82 s | capture `0B048240UX508924R` | payment: **poll** (scenario capture sync); pack, check, ack, snapshot: Cleared's own jobs |
| 2a Real `PENDING / PENDING_REVIEW` hold, explained in Hindi with the estimate and its source | 0:45–1:05 (20 s) | pass | 9 s | capture `63R756703X9265145` | hold: **webhook** (payment `source = webhook` from the pool capture). On production the payment row reads `PENDING / PENDING_REVIEW` |
| 2b Goods: the seller declares "goods" (labelled as her answer), route advice, File tracking → approve → filed | (same window) | pass | 12 s | tracking `debug_id ca5492f996d63` | the declaration is Cleared's own field; tracking is a seller-approved PayPal write (201). PayPal's estimate stays `payment_review` ("Within 24 hours; up to 3 business days") |
| 3a Dispute lands → `PENDING/BUYER_COMPLAINT`, bell, draft, approval, evidence filed | 1:05–1:50 (45 s) | pass | 3 min 19 s | dispute `PP-R-LHX-10196097`, `debug_id f2295179440e7` | hold: **webhook** `CUSTOMER.DISPUTE.CREATED` → capture re-fetch (payment `source = webhook`) |
| 3b Labelled "Simulate PayPal's decision (sandbox only)" → `RESOLVED_WITH_PAYOUT`, capture `COMPLETED`, both in the UI | (same) | pass | 8 min 52 s | dispute `PP-R-LHX-10196097`, capture `0B048240UX508924R` | release to `COMPLETED`: **poll** (scenario poll); final payment `source = webhook` |
| 3 email alert | (same) | fail | n/a | n/a | in-app bell only. Demo workspaces get no email by design (M3-08); showing the email needs an allowlisted owner workspace |
| 4a Audit log: the agent's proposal, the seller's approval, the sent row with its `debug_id` | 1:50–2:15 (25 s) | pass | 2 s | `debug_id f2295179440e7` | Cleared's audit rows |
| 4b Cash calendar (Bryntum month view, rendered in Chromium) + table | (same) | pass | 2 s | n/a | `released` $120 (PayPal's date) and $64 `estimated` (Source) rows. Third-party hosts on the production calendar page: **none** (no GTM, no bryntum.com) |
| 5 Guided Completed: the seller declares the $120 logo payment a service and confirms Completed | n/a | pass | 6 s | hold on capture `0B048240UX508924R` (`BUYER_COMPLAINT`) | Cleared's own record. "Saved. Your estimate hasn't changed."; PayPal's state and estimate unchanged |

**The one assertion that failed in run 2.** It was a soft check in scene 3a: the spec expected one
`dispute_deadline` row in the calendar while the case was open, and found **0**. Production SQL shows that
`seller_response_due_date` is null on both sandbox chargebacks (`PP-R-LHX-10196097`, `PP-R-XID-10196080`),
and the dispute page says "PayPal gives no reply date". So the calendar was right not to invent a deadline;
the spec's expectation was wrong.
- The spec now expects a deadline row exactly when PayPal sent a due date (`detail.dispute.dueDate`), so 0 here.
- That fix came after run 2. It hasn't run live yet: the demo-workspace quota for the day (3 per IP) is used up.
- Everything else in run 2 passed, so the Playwright verdict was **1 failed** on that check alone.

### Scene timings (run 2, UTC)

| Mark | At | |
|---|---|---|
| start / workspace | 06:03:34 | |
| scenario started → payment visible | 06:03:46 → 06:04:00 | 14 s |
| AI scope check done (6 lines: `met` ×3, `unverifiable` ×3; 11 verbatim citations) | 06:04:44 | 44 s after the payment |
| client confirmed from a second browser | 06:04:51 | |
| scope snapshot downloaded | 06:04:57 | |
| review hold in the inbox | 06:04:57 | |
| HI explanation (`lang="hi"`, rule `payment_review`, https source link) | 06:05:06 | |
| tracking approved → filed (201) | 06:05:11 → 06:05:18 | 7 s |
| capture `PENDING / BUYER_COMPLAINT`, dispute mirrored | 06:07:11 | |
| agent draft proposed | 06:08:17 | 66 s after |
| seller approved → evidence filed (200) | 06:08:22 → 06:08:37 | 15 s |
| service declared + Completed confirmed | 06:08:43 | |
| decision control enabled and clicked | 06:12:07 | 3 min 30 s after filing |
| dispute `RESOLVED` / `RESOLVED_WITH_PAYOUT` | 06:17:30 | 5 min 22 s after the decision |
| "Hold released: payment is Completed" | 06:17:31 | |
| audit log, calendar | 06:17:36, 06:17:39 | |

The UI reads "Resolved; you keep the money (PayPal covered the case)". No page contains "won".

## AC checks on production (read-only SQL, `cleared-prod-select`)

```
executions (workspace 7d178710…):
  2026-11-03 06:05:12Z  add_tracking      201  ca5492f996d63
  2026-11-03 06:08:25Z  provide_evidence  200  f2295179440e7
payments:  63R756703X9265145  PENDING    PENDING_REVIEW  (poll at read time)
           0B048240UX508924R  COMPLETED                  webhook
holds:     review   PENDING_REVIEW   filed     seller_declared_kind goods
           dispute  BUYER_COMPLAINT  released  seller_declared_kind service
disputes:  PP-R-LHX-10196097  RESOLVED  CHARGEBACK  seller_response_due_date null
```

The pool CLI's capture GET (`/v2/payments/captures/:id`, 200, `debug_id f317634bace8c`) returned
`PENDING / PENDING_REVIEW` for `63R756703X9265145` at 05:55:13Z. That is the AC 2 check; it ran on
production's own worker.

## Spend

OpenAI cost per run, from `agent_runs` (the API's token counts, priced by the app):

| Task | Run 1 | Run 2 |
|---|---|---|
| `check_scope` (×2) | $0.0172 | $0.0162 |
| `draft_dispute` (×2) | $0.0082 | $0.0081 |
| `extract` (×5) | $0.0011 | $0.0011 |
| `explain_hold` | $0.0001 (×1) | $0.0003 (×2) |
| **Total** | **$0.0267** | **$0.0257** |

Both runs together: **$0.0524** of the $0.50 budget. PayPal sandbox: $0.

## Deltas for M5-02 (timings against the < 3:00 cut)

- **Scene 1 (82 s against 25 s):** the AI check takes ~45 s. Cut from the paste/upload to the checked verdicts.
- **Scene 2 (21 s against 20 s):** fits as-is, the review hold and HI explanation plus the goods declaration
  and tracking. The pool hold must be under 20 h old to assign; this one was captured at 05:55Z, releases
  ~24 h later (estimated), and must be assigned by ~2026-11-04 01:55Z.
- **Scene 3 (12 min 11 s against 45 s):** stage the chargeback ~20 min ahead, as §2 says. The dispute
  webhook took ~3 min, the draft about 1 min, the filing 15 s, the decision control 3.5 min, and the
  resolution 5.4 min.
- **Scene 4:** fits (4 s). The Bryntum trial watermark shows on the calendar; P-38 is deferred to M5-SUBMIT.
- **Copy:** the UI string is "Resolved; you keep the money (PayPal covered the case)". The storyboard's
  "she keeps the $120" is voice-over only.
- **Approval:** the spec clicks Approve as the synthetic demo seller (as M2-10's judge spec does). In the
  recording, the owner clicks it on camera.
- **Email alert:** record scene 3 in the owner's allowlisted workspace to show it.
- **Scene 5:** declaring the hold a service and confirming Completed works only while the hold is open, i.e.
  before the decision. In the video, show it between filing and the decision.

## Screenshots (run 2)

- `m3-storyboard-s1-pack-verdicts.png`: the pack, verdicts and quotes, and the seller's added items
- `m3-storyboard-s1-client-ack.png`: the client's confirmation in the second browser
- `m3-storyboard-s2-hi-hold-detail.png`: the real `PENDING_REVIEW` hold, AI explanation in Hindi, estimate and sources
- `m3-storyboard-s2-goods-route-advice.png`: "You marked this as goods", route advice, the tracking card
- `m3-storyboard-s2-tracking-filed.png`: tracking filed with PayPal's `debug_id`; PayPal's estimate unchanged
- `m3-storyboard-s3-evidence-filed.png`: the filing status with PayPal's `debug_id`
- `m3-storyboard-s3-dispute-resolved.png`: the resolved dispute, the outcome and the audit trail
- `m3-storyboard-s3-scenario-resolved.png`: the scenario timeline, hold released
- `m3-storyboard-s4-audit.png`: the audit log
- `m3-storyboard-s4-calendar.png`: the cash calendar month view and table
- `m3-storyboard-s5-completed-done.png`: "You marked this as a service", Completed confirmed, the estimate unchanged

## Run 1 (superseded)

Run 1 was on 04:11–04:28 UTC with web on `1463670`. **Scenes 1, 3 and 4a passed:**
- dispute `PP-R-XID-10196080` resolved as `RESOLVED_WITH_PAYOUT`;
- capture `85R37727PK2111840` went to `COMPLETED`;
- the filing returned 200 with `debug_id f696998b0718a`.

**Scenes 2, 4b and 5 failed on blockers that have since cleared:**
- no production pool;
- no goods/service path (fixed by #130);
- the web build of #127 failed on Render (BL-01 6595246110, fixed by #129).

## Defects and observations filed

| What | Where |
|---|---|
| No product path made a goods or service hold | BL-01 6570499264, fixed by #130 (option A); proven live in scenes 2b and 5 |
| No production review-hold pool | BL-01 6575469150: pool created over `render ssh` (staging above) |
| Render web build of #127 failed | BL-01 6595246110, fixed by #129 |
| The draft leaves the seller's later items unselected, including the client's sign-off and the scope snapshot | BL-01 6595501766 (owner M3-06) |
| "Thanks, Northwind Tea Co.. Your confirmation is recorded.": a double full stop when the client's name ends in "." | BL-01 6595502129 (owner M4-03) |
| The review hold's EN explanation showed the labelled standard text ("no AI summary right now"); its HI one was AI | observation only: the fallback is labelled as designed (M3-02) |
