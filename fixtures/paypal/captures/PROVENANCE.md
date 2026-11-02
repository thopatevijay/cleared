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
