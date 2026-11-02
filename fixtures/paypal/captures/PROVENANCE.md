# Capture fixtures: provenance (M3-01)

M0-04 recorded no payment-review capture, so these two files carry the real sandbox responses from the
feasibility spike (2026-10-26 to 2026-10-28), copied verbatim from
`~/hackathons/.research/paypal-ai-hackathon/spike/results/`:

| File | Spike file | What it is |
|---|---|---|
| `pending-review.json` | `wallet_review.json` | The capture of a PayPal-wallet order (capture id `5JB55617195805514`), as the spike script summarised it: HTTP 201, `capture_status: PENDING`, `status_details.reason: PENDING_REVIEW` |
| `pending-review-released.json` | `wallet_review_after.json` | The same capture re-read after PayPal released the review hold: HTTP 200, `status: COMPLETED`, `status_details: null`, `update_time` 24 h 0 m 5 s after `create_time` |

- **Shape.** The spike stored a summary of each response, not the full wire body: `pending-review.json`
  has `capture_status` (not `status`) and no amount; `pending-review-released.json` has no id or amount.
  The bodies are wrapped in the usual fixture envelope (`meta` / `request` / `response`, see
  `fixtures/README.md`), with `meta.source` naming the spike file. Tests read the status with
  `status ?? capture_status`.
- **Recorded at.** `pending-review.json`: the capture's `create_time` (2026-10-26T11:24:21Z).
  `pending-review-released.json`: re-read on 2026-10-28; the spike kept the date, not the time.
- **Scrubbing.** Neither file holds a token, email, name, address, payer or merchant id (checked by hand
  on copy). The capture id and PayPal's statuses are kept (the flow needs them).
- **Amounts.** None was recorded. Where a test or the E2E seed needs one, it uses the synthetic demo
  amount ($64.00 USD, Kofi Mensah, `docs/design/screens/dashboard.md`) with the recorded status/reason.

`../spec/capture-status-details-reason.json` is the `capture_status_details.reason` enum and its
descriptions from PayPal's Orders OpenAPI spec (version 2.36, downloaded 2026-10-26 to
`~/hackathons/.research/paypal-ai-hackathon/raw/verify/spec/orders.json`). The rule-table test fails if
a value there has no row in `packages/core/src/holds/rules.ts`.

## Live review-hold pool (M3-10, 2026-11-02)

Recorded through the product adapters by `scripts/spikes/m3-10-pool-record.ts` (`createRecorder` +
`createScrubber`, so emails, names, payer/merchant/account ids are placeholders and the token is
`[REDACTED]`), at 2026-11-02T12:08Z. These are full wire bodies, not spike summaries. The orders are
PayPal-wallet orders the pool CLI created at 10:59Z, approved by the owner as the sandbox buyer (P-52),
and captured by `pool:capture` at 11:57Z with `PayPal-Request-Id` set to the pool row id.

| File | Capture | Order | Status / reason | debug id |
|---|---|---|---|---|
| `pool-judge-a.json` | `3LA86131WB155820G` | `4PC61975WK2620801` (judge, $64.00) | `PENDING` / `PENDING_REVIEW` | f813004b204c2 |
| `pool-judge-b.json` | `5G970215P3288890U` | `19G90337AA231742C` (judge, $48.00) | `PENDING` / `PENDING_REVIEW` | f755196063c25 |
| `pool-video.json` | `84S22913092039910` | `0VU267969U7919544` (video, $64.00) | `PENDING` / `PENDING_REVIEW` | f131855f10f30 |

The matching order GETs (`COMPLETED`, with the capture embedded) are in `../orders/pool/`, and the token
exchange is in `../oauth/token-m3-10.json`. The capture POSTs' debug ids from the `pool:capture` run are
f569572a059dd, f667813b861fe and f9621049c9de7. The M3-10 AC 3 replay (`apps/worker/src/cli/pool.int.test.ts`)
serves `pool-video.json`, keeping its status and reason verbatim and giving it fresh ids so the test can re-run.
