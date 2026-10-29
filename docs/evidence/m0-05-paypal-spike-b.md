# M0-05 evidence: PayPal spike B (disputes) in TypeScript

- **Runs (2026-10-29, UTC):**
  - 05:16:51–05:43:21 (1590 s): main run, `pnpm tsx --env-file=<main checkout>/.env scripts/spikes/paypal-b.ts --record`. It runs three disputes in parallel (exit 0)
  - 05:35:09: request-id probe, `… paypal-b.ts --record --idempotency` (one more dispute; exit 0)
  - 05:47:24: require-evidence probe on that dispute, `… --record --require-evidence --dispute PP-R-TCZ-10195079` (exit 0)
  - 05:43:51 and 05:52:11: follow-up reads, `… --idempotency --raw-retry-only --dispute … --request-id … --full-capture … --accept-dispute … --accept-capture …`
- **Environment:** PayPal **sandbox** (`api-m.sandbox.paypal.com`) with the project sandbox app (P-21). `PAYPAL_ENV` was unset, so the script's guard passed, and the client's sandbox-only calls received `"sandbox"`
- **Spend:** $0 (sandbox; no OpenAI calls)
- **Code path:** the product adapters.
  - `createHttpClient` → `createTokenProvider` → `createPayPalDisputesClient` (guarded), plus `createPayPalOrdersClient` for the card capture and the capture GETs.
  - `createDisputesTransport` (raw) was used only to record PayPal's own refusals.
  - Fixtures came from the client's `onExchange` hook and went through the M0-04 scrubber, which now also scrubs the dispute's `buyer.name` and `seller.name`.
- **Output:** 60 scrubbed fixtures under `fixtures/paypal/disputes/` (inventory in `fixtures/README.md`), plus the synthetic `fixtures/samples/evidence/delivery-note.pdf` (1124 bytes; one page)

## Disputes (sandbox ids)

| Flow | Purpose | Capture (USD) | Dispute |
|---|---|---|---|
| `full` | chargeback → supporting info → evidence → adjudicate SELLER_FAVOR → RESOLVED → capture released | `794390931G848631R` (64.00) | `PP-R-UVC-10195076` |
| `unknown` | writes sent before their link existed; then a supporting-info write with a 300 ms client timeout, a re-read, and a retry with the same `PayPal-Request-Id` | `7MJ69441LL4596355` (23.00) | `PP-R-VFE-10195075` |
| `accept` | accept-claim (REFUND), then the capture/refund state | `54W821880C511020E` (9.00) | `PP-R-ARH-10195077` |
| `idempotency` / `require` | the same `PayPal-Request-Id` sent twice while the link was present; later evidence → require-evidence on the same dispute | `1ST20025PU742944J` (12.00) | `PP-R-TCZ-10195079` |

All four disputes are stage `CHARGEBACK`, reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` (reason code `C2`) and channel `EXTERNAL`. `listDisputes({ updateTimeAfter: <run start − 60 s> })` returned exactly these four (`list/update-time-after`).

## PayPal APIs exercised (real calls)

| API | Call | Result |
|---|---|---|
| Customer Support (sandbox) | `POST /v2/customer-support/process-chargeback` | 201 `{ dispute_id }` (×4) |
| Disputes v1 | `GET /v1/customer/disputes/{id}` | 200 at every poll |
| Disputes v1 | `GET /v1/customer/disputes?update_time_after=…&page_size=50` | 200, 4 items |
| Disputes v1 | `POST …/provide-supporting-info` (multipart: `input` JSON `{notes}` + optional PDF `file1`) | 200 `{links:[detail]}` |
| Disputes v1 | `POST …/provide-evidence` (multipart: `input` `{evidences:[{evidence_type: PROOF_OF_FULFILLMENT, documents:[{name}], notes}]}` + PDF) | 200 `{links:[detail]}` |
| Disputes v1 (sandbox) | `POST …/adjudicate` `{adjudication_outcome: SELLER_FAVOR}` | 200; the body is a single link object, not `{links}` |
| Disputes v1 | `POST …/accept-claim` `{note, accept_claim_type: REFUND}` (JSON) | 200 `{links:[detail]}` |
| Disputes v1 (sandbox) | `POST …/require-evidence` `{action: SELLER_EVIDENCE}` | 200 once its link appeared (after evidence, `UNDER_REVIEW`): the dispute went back to `WAITING_FOR_SELLER_RESPONSE` (links `accept_claim`, `provide_evidence`) with a **new `seller_response_due_date` 2026-11-02T04:59:59Z** (≈ 4 days, shorter than the first ≈ 11) (`require/*`) |
| Payments v2 | `GET /v2/payments/captures/{id}` | the hold and the release (below) |
| Orders v2 | card order create (M0-04 helper) and `GET` order for `payee.merchant_id` | 201 `COMPLETED` / 200 |

## States and links seen (`full/state-N-*`, `*/state-N-*`)

| # | `status` | Links (`rel`, besides `self`) | First seen (`update_time`) | Note |
|---|---|---|---|---|
| 1 | `OPEN` | none | at create | `seller_response_due_date` null |
| 2 | `UNDER_REVIEW` | `provide_supporting_info` | +54–56 s | the same in all four disputes |
| 3 | `WAITING_FOR_SELLER_RESPONSE` | `provide_evidence`, `accept_claim` | +3 min 35 s | `seller_response_due_date` 2026-11-09T04:59:59Z (≈ 11 days). `evidences[]` gains three `REQUESTED_FROM_SELLER` entries: `PROOF_OF_FULFILLMENT`, `PROOF_OF_REFUND`, `OTHER` |
| 4 | `UNDER_REVIEW` | `adjudicate`, `require_evidence`, `provide_supporting_info` | 3 min 24 s after evidence | the three requested entries are replaced by our `PROOF_OF_FULFILLMENT` / `SUBMITTED_BY_SELLER` entry |
| 5 | `UNDER_REVIEW` | none | ≈ 1 min 45 s after adjudicate | sandbox decision in progress |
| 6 | `RESOLVED` | none | 6 min 35 s after adjudicate | `dispute_outcome`: `RESOLVED_WITH_PAYOUT` / `REPRESENTED_BY_PAYPAL`, `amount_refunded` 64.00 |

- **The transition to `WAITING_FOR_SELLER_RESPONSE` is time-based.** The `accept` dispute sent no supporting info and still moved at the same moment (+3 min 33 s) as the two disputes that did.
- **The same status carries different link sets** (`UNDER_REVIEW` has three distinct sets above), which is why `allowedActions` reads only `links[].rel`. The replay test checks every recorded state against its links.

## The money: hold and release (`full/capture-*`, `fund_movements`)

| Time (UTC) | Capture `794390931G848631R` | Dispute `fund_movements` |
|---|---|---|
| 05:16:54 | `COMPLETED` (`capture-1-completed`) | |
| 05:20:04 | **`PENDING` / `BUYER_COMPLAINT`** (`capture-2-pending`) | `HOLD_PLACED` DEBIT 61.85 (the net amount) |
| 05:33:04 | | `HOLD_RELEASED` CREDIT 61.85 |
| 05:38:42 | **`COMPLETED`** again (`capture-3-completed`) | |

The outcome text is **"seller keeps the money (PayPal covered the case)"** (`describeOutcome`), never a win. Two `adjudications[]` entries of type `PAYOUT_TO_BUYER` / `REPRESENTED_BY_PAYPAL` (05:31:58 and 05:37:23) show that PayPal, not the seller, paid the buyer.

## Timings (full path)

| Step | At (UTC) | Since the chargeback |
|---|---|---|
| chargeback 201 | 05:16:59 | 0 |
| supporting info 200 | 05:18:05 | 1 min 06 s |
| capture on hold | 05:20:04 | 3 min 05 s |
| `WAITING_FOR_SELLER_RESPONSE` | 05:20:34 | 3 min 35 s |
| evidence 200 (first poll that saw the link) | 05:27:29 | 10 min 30 s |
| `adjudicate` link appears | 05:30:53 | 13 min 54 s |
| adjudicate 200 | 05:31:58 | 14 min 59 s |
| `RESOLVED` | 05:38:33 | **21 min 34 s** |
| capture `COMPLETED` (released) | 05:38:42 | **21 min 43 s** |

- **Polling** was ≥ 60 s per dispute; the 45 min give-up was never reached.
- **Two unexplained pauses.** The whole process logged nothing for two stretches: about 9 min between 05:18:07 and 05:27:25, and about 4 min between 05:27:29 and 05:31:55. All three flows paused together, so the evidence went in about 7 min after its link appeared (05:20:34). **Cause not established.** INFERENCE: it came after the aborted (timed-out) request, so the shared HTTP connection pool is a suspect. It's logged on BL-01.
- **Dispute-side times** come from PayPal's `update_time` values. With prompt actions, the path would take about 15 min.

## Writes before their link: PayPal's refusals (`errors/*`)

| Write (link absent) | State | PayPal |
|---|---|---|
| `provide-evidence` | `OPEN` | 422 `UNPROCESSABLE_ENTITY` / `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` |
| `adjudicate` | `OPEN` | 400 `INVALID_REQUEST` / same issue |
| `require-evidence` | `OPEN` | 400 `INVALID_REQUEST` / same issue |
| `accept-claim` | `OPEN` | 422 / same issue |
| `accept-claim` | `RESOLVED` | 422 / same issue |
| `provide-supporting-info` | `RESOLVED` | 422 / same issue |

The product client never sends these. Its guard re-reads the dispute and throws `DisputeActionNotAllowedError` with no POST: `unknown/guard-refused-evidence` is a GET-only fixture. The raw transport sent them only to record PayPal's answers.

**Client-side guards** run before any HTTP call, so they have no fixtures. They are proved in `disputes.test.ts`: file type (jpg/jpeg/gif/png/pdf only), a file of 10 MB or more (decimal MB, the stricter reading), more than 50 MB per call, an empty file, and notes over 2000 characters.

## Unknown outcome: a client timeout on a write

1. **Before:** `PP-R-VFE-10195075` was `UNDER_REVIEW`, with links `provide_supporting_info` and `supporting_info` null (`unknown/before`).
2. **The write:** `provideSupportingInfo` was called with `timeoutMs: 300`. The re-check GET succeeded (`unknown/timeout-precheck-get`), and the POST raised `HttpTimeoutError` with `outcomeUnknown: true`. There was no response, so there is no fixture for the POST itself.
3. **Re-read after 60 s** (`unknown/after-timeout`): **the write had landed.** `supporting_info[0]` holds our notes, with `source: SUBMITTED_BY_SELLER` and `provided_time` 05:18:07.234Z, about 0.25 s after the client gave up. The dispute had also moved on to `WAITING_FOR_SELLER_RESPONSE`, and the `provide_supporting_info` link was gone.
4. **Guarded retry with the same `PayPal-Request-Id`:** refused client-side, because the link was absent (`unknown/retry-same-request-id-failed`, GET only).
5. **Raw retry with the same `PayPal-Request-Id`** (`unknown/raw-retry-same-request-id`): **422 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`**. PayPal did **not** replay the first (successful) result for that id.
6. **The same id twice while the link was present** (`idempotency/first`, `idempotency/second-same-id`): **both returned 200, and the re-read shows two `supporting_info` entries** (`idempotency/after`).

**Finding:** on Disputes v1, `PayPal-Request-Id` is **not an idempotency key**. This differs from Orders v2 (M0-04, where the same id replayed the same order). So:

- `DISPUTE_WRITES_IDEMPOTENT = false`: the shared client never retries a dispute write on timeout or 5xx.
- A timed-out write is `unknown`. Reconcile it by re-reading: `reconcileAfterTimeout(action, before, after)` compares seller submissions (`supporting_info[]` plus evidence with `source: SUBMITTED_BY_SELLER`) for the submit actions. For the other actions it checks whether the link disappeared or the status changed. `update_time` alone is not proof. The replay test reproduces "landed" from the recorded before/after pair.
- M2-08: `executing → unknown → reconcile`. Never resend automatically. If the re-read says `not_landed`, the next attempt needs a fresh approval check against fresh links.

## accept-claim (`accept/*`)

- The `accept_claim` link appeared with `WAITING_FOR_SELLER_RESPONSE` (+3 min 33 s). `acceptClaim(…, { acceptClaimType: "REFUND" })` was sent at 05:27:28 and got 200.
- **Afterwards:** the dispute went back to `UNDER_REVIEW`, with only the `provide_supporting_info` link. The capture stayed **`PENDING` / `BUYER_COMPLAINT`**, with links `refund` and `up` and no refund recorded on it.
  - Re-read at 05:43:55: still `UNDER_REVIEW`, with only `provide_supporting_info`. The dispute's `update_time` had moved to 05:43:26.
  - Re-read at 05:52:15 (`accept/later-under_review` and `accept/later-capture-pending`; this read overwrote the 05:43 files): still `UNDER_REVIEW` (`update_time` 05:46:04). The links are now `adjudicate`, `require_evidence` and `provide_supporting_info`, the same set as the full path after evidence. The capture is still `PENDING` / `BUYER_COMPLAINT`.
  - **The accept-claim was filed as evidence.** `evidences[]` gained `OTHER` / `SUBMITTED_BY_SELLER`, carrying our accept note. `fund_movements` shows only `HOLD_PLACED` 8.28; there is no refund and no `dispute_outcome`. `offer.buyer_requested_amount` is 9.00.
- **Finding:** on a sandbox chargeback, accept-claim is not a refund. It is recorded as a seller response, and the case waits for PayPal's decision; we left it there (25 min after the 200, still unresolved). So:
  - The product keeps showing the hold until PayPal reports `RESOLVED` with an outcome.
  - It never tells the seller "refunded" on the strength of the 200 alone.
  - For `accept_claim`, M2-08's reconcile uses "the link disappeared" (`reconcileAfterTimeout`), not seller submissions.

## Reproduce

```bash
pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-b.ts --record              # ≈ 25–45 min
pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-b.ts --record --idempotency # ≈ 3 min
pnpm --filter @cleared/adapters test disputes                                         # offline replay
```
