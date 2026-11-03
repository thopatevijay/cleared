# M3-11 · Storyboard dry run on production: evidence

Three live runs of `apps/web/e2e/storyboard.spec.ts` against **production**
(`https://cleared-web-gd1b.onrender.com`, Render, Oregon), in deployed mode: no local server, no stub,
no credential in the test.

| Run | When (2026-11-03, UTC) | Production build | Verdict |
|---|---|---|---|
| 1 | 04:11–04:28 | web `1463670`, worker `f93f88d` | 1 failed: blockers on scenes 2, 4b and 5 (since cleared) |
| 2 | 06:03–06:18 | web + worker `c5afc1c` (#129 build fix, #130 declaration) | 1 failed on one soft check (wrong test expectation, fixed in 5ece0b3) |
| **3 (of record)** | **06:37–06:52** | web + worker `c5afc1c`, spec at `f438408` | **1 passed (14.6 min)** |

Every PayPal call ran on the **PayPal sandbox**. All personal data is synthetic:
- the seller is an anonymous "Try as demo seller" workspace;
- the client is "Northwind Tea Co." and the designer is "Meera Studio", both from `fixtures/scenario/`;
- the review-hold payment was approved by the sandbox buyer account (P-52).

The ids are sandbox ids. No secret values appear here.

## Staging (run 3)

The pool commands ran over `render ssh` on cleared-worker (production's own env), per
docs/runbooks/review-hold-pool.md.

| Step | When (UTC) | Result |
|---|---|---|
| `pool.ts status` before creating (Run 3 ran from a different network because of the 3 demo workspaces/IP/day limit, so `cleared-prod-select` was refused by the DB allowlist) | ~06:30 | 1 row, run 2's, already assigned; no unassigned rows |
| `pool.ts create --count 1 --purpose video` | ~06:31 | order `1LW295297L0790456`, 64.00 USD; create-order 200, `debug_id ca549559bedfc` |
| The owner approved the order as the sandbox buyer (P-52) | before 06:34 | |
| `pool.ts capture` | ~06:34 | capture POST **201**, `debug_id ca5495a297fdd`; capture `5MH87432EV4324634` **`PENDING / PENDING_REVIEW`**; re-read by GET 200 (`debug_id ca5495a31085a`); row `held` |
| `pool.ts status` | ~06:35 | `video held 1LW295297L0790456 5MH87432EV4324634 PENDING/PENDING_REVIEW`, expected release `~2026-11-04T06:34Z` (estimated, rule `payment_review`) |
| `/readyz` | 06:37 | `{"ok":true,"checks":{"db":true,"queue":true,"worker":true,"reconcile":true}}` |
| Recording workspace created by the spec | 06:37:58 | `987d00e3-6c71-416c-ac1c-97571db0493f` |
| `pool.ts assign --workspace 987d00e3…` | ~06:38 | "assigned capture 5MH87432EV4324634 (order 1LW295297L0790456)" |
| Chargeback (M2-10 scenario, on the $120 card capture) | ~06:38 | staged live in the run, not 20 min ahead |

| Run 3 ids | |
|---|---|
| scenario run | `1fb82b06-f362-4b3a-877a-d4939f414f0b` |
| $120 card order / capture | `57T10330WD5617918` / `1V857327YR188313C` (payment `a631e884-7c3b-4147-8042-bb67a815a7c5`) |
| dispute | `PP-R-TRN-10196104` (stage `CHARGEBACK`, reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`) |
| $64 review-hold capture | `5MH87432EV4324634` (order `1LW295297L0790456`) |
| tracking (`add_tracking`, IND_DELHIVERY `CLRM311001`, synthetic) | filed after the seller's approval, PayPal `debug_id ca54961783ef2` |
| evidence filing (`provide_evidence`, fingerprint `c326704e`) | PayPal **200**, `debug_id f8280104a60c9` |

## Scenes (run 3)

The storyboard column is PROJECT.md §2. "Wall time" is what the scene took in this run. "Source" is what
moved the state Cleared shows: a verified PayPal webhook, or Cleared's own poll / re-fetch. Each source is
the payment's `source` as the app's `/api/payments` returned it during the run.

| Scene | Storyboard | Result | Wall time | Sandbox ids | Source of each state change |
|---|---|---|---|---|---|
| 1 Proof pack: payment arrives, chat + files, AI scope check with quotes, client acknowledgement, scope snapshot | 0:20–0:45 (25 s) | pass | 58 s | capture `1V857327YR188313C` | payment: **poll** (scenario capture sync); pack, check, ack, snapshot: Cleared's own jobs |
| 2a Real `PENDING / PENDING_REVIEW` hold, explained in Hindi with the estimate and its source | 0:45–1:05 (20 s) | pass | 11 s | capture `5MH87432EV4324634` | hold: **webhook** (the pool capture's payment row) |
| 2b Goods: the seller declares "goods" (labelled as her answer, not PayPal's), route advice, File tracking → approve → filed | (same window) | pass | 12 s | tracking `debug_id ca54961783ef2` | the declaration is Cleared's own field; tracking is a seller-approved PayPal write. PayPal's estimate stays `payment_review` |
| 3a Dispute lands → `PENDING/BUYER_COMPLAINT`, bell, draft, approval, evidence filed | 1:05–1:50 (45 s) | pass | 3 min 8 s | dispute `PP-R-TRN-10196104`, `debug_id f8280104a60c9` | hold: **webhook** (`CUSTOMER.DISPUTE.CREATED` → capture re-fetch) |
| 3a calendar deadline row while the case is open | (same) | pass | n/a | n/a | PayPal sent no `seller_response_due_date` ("PayPal gives no reply date"), so the calendar correctly shows no deadline row (0) |
| 3b Labelled "Simulate PayPal's decision (sandbox only)" → `RESOLVED_WITH_PAYOUT`, capture `COMPLETED`, both in the UI | (same) | pass | 9 min 52 s | dispute `PP-R-TRN-10196104`, capture `1V857327YR188313C` | release to `COMPLETED`: **poll** (scenario poll) |
| 3 email alert | (same) | fail | n/a | n/a | in-app bell only. Demo workspaces get no email by design (M3-08); showing the email needs an allowlisted owner workspace |
| 4a Audit log: the agent's proposal, the seller's approval, the sent row with its `debug_id` | 1:50–2:15 (25 s) | pass | 3 s | `debug_id f8280104a60c9` | Cleared's audit rows |
| 4b Cash calendar (Bryntum month view, rendered in Chromium) + table | (same) | pass | 2 s | n/a | third-party hosts on the production calendar page: **none** (no GTM, no bryntum.com) |
| 5 Guided Completed: the seller declares the $120 logo payment a service and confirms Completed | n/a | pass | 7 s | hold on capture `1V857327YR188313C` (`BUYER_COMPLAINT`) | Cleared's own record. "Saved. Your estimate hasn't changed."; PayPal's state and estimate unchanged |

### Timings (run 3, UTC)

| Mark | At | |
|---|---|---|
| start / workspace | 06:37:58 | |
| scenario started → payment visible | 06:38:07 → 06:38:13 | 6 s |
| AI scope check done (6 lines: `met` ×3, `unverifiable` ×3; 9 verbatim citations) | 06:38:42 | 29 s after the payment |
| client confirmed from a second browser; snapshot downloaded | 06:38:55; 06:38:56 | |
| review hold in the inbox → HI explanation (`lang="hi"`, rule `payment_review`, https source) | 06:38:57 → 06:39:08 | |
| tracking approved → filed | 06:39:13 → 06:39:20 | 7 s |
| capture `PENDING / BUYER_COMPLAINT`, dispute mirrored | 06:41:10 | |
| agent draft proposed (`PROOF_OF_FULFILLMENT`, notes 723/2000, one compiled PDF 222 KB) | 06:42:15 | 65 s after |
| seller approved → evidence filed (200); six checks passed | 06:42:19 → 06:42:28 | 9 s |
| service declared + Completed confirmed | 06:42:35 | |
| decision control enabled and clicked | 06:46:22 | 3 min 54 s after filing |
| dispute `RESOLVED` / `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL` | 06:52:22 | 6 min after the decision |
| "Hold released: payment is Completed" | 06:52:23 | |
| audit log, calendar | 06:52:28, 06:52:31 | |

The UI reads "Resolved; you keep the money (PayPal covered the case)". No page contains "won".

## AC checks

| AC | Evidence (run 3) |
|---|---|
| 2: the hold is real, explained in HI, with a source | the capture GET on production (pool CLI, cleared-worker) returned 200, `debug_id ca5495a31085a`, `PENDING / PENDING_REVIEW` for `5MH87432EV4324634`; screenshot `s2-hi-hold-detail` |
| 3: `RESOLVED_WITH_PAYOUT`, capture `COMPLETED`, both in the UI | the spec asserted `GET /api/scenarios/:id` `dispute.status = RESOLVED`, `outcome = RESOLVED_WITH_PAYOUT / REPRESENTED_BY_PAYPAL`, `capture.status = COMPLETED`; the UI outcome and "Hold released" text; screenshot `s3-dispute-resolved` |
| 4: 2xx `debug_id` in `executions` for the filing and the tracking | filing: the app's `GET /api/disputes/:id` (built from `executions`) returned `paypalStatus` 200 and `debug_id f8280104a60c9`, which the spec asserted; the audit row reads "Completed (200)". Tracking: "Tracking filed … PayPal debug_id ca54961783ef2" (the action reaches filed only on a 2xx) |

**Pending re-check from the home network:** a direct SQL read of `executions`, `payments`, `holds`,
`disputes`, `webhook_events` and `agent_runs` for workspace `987d00e3…`. Run 3 ran from a hotspot IP
outside the DB allowlist, and a read-only `psql` through the worker over `render ssh` was refused by the
build's permission system. The same SQL checks on run 2 (same code, same path) returned `add_tracking` 201
and `provide_evidence` 200.

## Spend

OpenAI cost per run, from `agent_runs` (the API's token counts, priced by the app):

| Run | Cost |
|---|---|
| 1 | $0.0267 (`check_scope` ×2 $0.0172, `draft_dispute` ×2 $0.0082, `extract` ×5 $0.0011, `explain_hold` ×1 $0.0001) |
| 2 | $0.0257 (`check_scope` ×2 $0.0162, `draft_dispute` ×2 $0.0081, `extract` ×5 $0.0011, `explain_hold` ×2 $0.0003) |
| 3 | **pending** the home-network SQL read (same pipeline and inputs, so expected in the same ~$0.03 range; not measured) |

Runs 1 + 2: **$0.0524** measured. PayPal sandbox: $0.

## Deltas for M5-02 (timings against the < 3:00 cut)

- **Scene 1 (58 s against 25 s):** the AI check takes ~30–45 s. Cut from the paste/upload to the checked verdicts.
- **Scene 2 (23 s against 20 s):** the review hold, HI explanation, goods declaration and tracking; a light
  trim fits. The pool row must be under 20 h old to assign. Run 3's row was captured at ~06:34Z and must be
  assigned by ~2026-11-04 02:34Z. Its release is estimated ~24 h after capture.
- **Scene 3 (13 min 0 s against 45 s):** stage the chargeback ~20 min ahead, as §2 says. The dispute
  webhook took ~3 min, the draft about 1 min, the filing 9 s, the decision control ~4 min, and the
  resolution ~6 min.
- **Scene 4 (5 s):** fits. The Bryntum trial watermark shows; P-38 is deferred to M5-SUBMIT.
- **Scene 5:** works only while the dispute hold is open. Show it between the filing and the decision.
- **Copy:** the UI string is "Resolved; you keep the money (PayPal covered the case)". The storyboard's
  "she keeps the $120" is voice-over only.
- **Approval:** the spec clicks Approve as the synthetic demo seller (as M2-10's judge spec does). In the
  recording, the owner clicks it on camera.
- **Email alert:** record scene 3 in the owner's allowlisted workspace to show it.
- **No reply deadline in the demo:** sandbox chargebacks carry no `seller_response_due_date`, so there is no
  deadline row or deadline alert to film.

## Screenshots (run 3)

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

## Earlier runs (superseded)

- **Run 1** (web `1463670`):
  - Dispute `PP-R-XID-10196080` → `RESOLVED_WITH_PAYOUT`; capture `85R37727PK2111840` → `COMPLETED`.
  - Filing 200, `debug_id f696998b0718a`.
  - Scenes 2, 4b and 5 were blocked, by the missing pool, the missing goods/service path and the failed #127 web build.
- **Run 2** (`c5afc1c`):
  - Pool order `6AE7350594037204V` / capture `63R756703X9265145` `PENDING/PENDING_REVIEW`.
  - Dispute `PP-R-LHX-10196097` → `RESOLVED_WITH_PAYOUT`.
  - Production SQL: `add_tracking` 201 `ca5492f996d63`, `provide_evidence` 200 `f2295179440e7`; `seller_response_due_date` null.
  - It failed on one soft check, which expected a calendar deadline row PayPal never sent. 5ece0b3 corrected the test.

## Defects and observations filed

| What | Where |
|---|---|
| No product path made a goods or service hold | BL-01 6570499264, fixed by #130 (option A); proven live in scenes 2b and 5 |
| No production review-hold pool | BL-01 6575469150: pool created on production over `render ssh` |
| Render web build of #127 failed | BL-01 6595246110, fixed by #129 |
| The draft leaves the seller's later items unselected, including the client's sign-off and the scope snapshot (seen again in run 3: E4–E7 unticked) | BL-01 6595501766 (owner M3-06) |
| "Thanks, Northwind Tea Co.. Your confirmation is recorded.": a double full stop when the client's name ends in "." | BL-01 6595502129 (owner M4-03) |
| A review hold's EN explanation showed the labelled standard text while its HI one was AI (run 2) | observation only: the fallback is labelled as designed (M3-02) |
