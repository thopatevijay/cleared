# M0-04 evidence: PayPal spike A (orders, capture, tracking) in TypeScript

- **Run:** 2026-10-29 04:57 UTC, one live run of
  `pnpm tsx --env-file=<main checkout>/.env scripts/spikes/paypal-a.ts --record`, exit 0
- **Environment:** PayPal **sandbox** (`api-m.sandbox.paypal.com`), the fresh project sandbox app (P-21).
  `PAYPAL_ENV` unset → the script's sandbox guard passed
- **Spend:** $0 (sandbox)
- **Code path:** the product adapters (`packages/adapters`): `createHttpClient` → `createTokenProvider` →
  `createPayPalOrdersClient`, with the fixture recorder on `onExchange`. No SDK (ADR 0011 addendum)
- **Output:** 18 scrubbed fixtures under `fixtures/paypal/{oauth,orders,tracking,errors}/`

## PayPal APIs exercised (real calls)

| API | Call | Result |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` (client_credentials) | 200, 29 scopes, `expires_in` 30456 s (≈ 8.5 h); a re-mint after revocation gave 32400 s (9 h) |
| OAuth 2.0 | `POST /v1/oauth2/token/terminate` | 200, empty body; the token is rejected immediately afterwards |
| Orders v2 | `POST /v2/checkout/orders` (card `payment_source`, `intent: CAPTURE`, `custom_id`, `PayPal-Request-Id`, `Prefer: return=representation`) | 201, order **`COMPLETED` in the same call** with the capture inside (no separate capture step) |
| Orders v2 | same request again with the **same** `PayPal-Request-Id` | same order id `2KC08730ML031160C`, same capture id (idempotent replay) |
| Orders v2 | `POST /v2/checkout/orders/{id}/capture` on that order | 422 `UNPROCESSABLE_ENTITY` / `ORDER_ALREADY_CAPTURED` |
| Orders v2 | `GET /v2/checkout/orders/{id}` | 200 `COMPLETED` |
| Payments v2 | `GET /v2/payments/captures/{id}` | 200 `COMPLETED`; **`custom_id` is on the capture** (equal to the order's); `seller_receivable_breakdown` gross 42.00 / fee 1.58 / net 40.42 USD; `supplementary_data.related_ids.order_id` present |
| Orders v2 tracking | `POST /v2/checkout/orders/{id}/track`, carrier `IND_DELHIVERY` | 201, tracker `<capture id>-<tracking number>` `SHIPPED` |
| Orders v2 tracking | same, carrier `OTHER` + `carrier_name_other` | 201, tracker `SHIPPED` |
| Add Tracking v1 (legacy) | `POST /v1/shipping/trackers-batch`, `status: COMPLETED`, no tracking number | 200, `errors: []`, identifier `<capture id>` |
| Add Tracking v1 (legacy) | `GET /v1/shipping/trackers/{capture id}-NOTRACKER` | 200, `status: COMPLETED`, `shipment_uploader: MERCHANT` |
| errors | create with `amount.value: "forty-two"` | 400 `INVALID_REQUEST` / `INVALID_PARAMETER_SYNTAX`, with `debug_id` |
| errors | `GET /v2/payments/captures/0NOTACAPTURE0000` | 404 `RESOURCE_NOT_FOUND` / `INVALID_RESOURCE_ID` |
| errors | GET order with the terminated token | 401 `invalid_token` ("Access Token not found in cache") → provider re-mints once → retried GET 200 |

## Ids (sandbox)

| Order | Purpose | Order id | Capture id |
|---|---|---|---|
| A | goods, USD 42.00; replay; GET; `IND_DELHIVERY` tracker | `2KC08730ML031160C` | `6BC19320SY177903T` |
| B | goods, USD 18.50; `OTHER` tracker | `3KD72075PM7588429` | `7F7924957B2117201` |
| C | service, USD 120.00; trackers-batch `COMPLETED` | `2EH61348VC003972S` | `7AS90958XD7569923` |

## Scopes on the fresh app's token (P-22)

The token carries **`https://uri.paypal.com/services/reporting/search/read`** (Transaction Search):
`transaction_search_scope: true`. The research spike's older app had none (`reporting: []` in
`spike/results/auth.json`). Also present: `disputes/read-seller`, `disputes/update-seller`,
`disputes/create`, `documents/disputes/download`, `shipping/trackers/readwrite`,
`applications/webhooks`, `payments/payouts`. The full list (29) is `response.body.scope` in
`fixtures/paypal/oauth/token.json`.

## Findings vs the research spike (Python, 2026-10-26/28)

| Topic | Research spike | M0-04 | Note |
|---|---|---|---|
| Card create | 201 `COMPLETED`, captured in create | same | Capture call is unnecessary with a card `payment_source`; a second capture → 422 `ORDER_ALREADY_CAPTURED` |
| Fees | 42.00 → fee 1.58 / net 40.42 | identical | `seller_receivable_breakdown` present at create and on GET capture |
| `custom_id` on capture | not checked | **present** | ownership can be resolved from a capture alone (M1-02) |
| Idempotency | not tested | same id on replay | `PayPal-Request-Id` works on create |
| Tracking (v2) | 201 for listed + `OTHER` | same | trackers come back as `SHIPPED` |
| trackers-batch `COMPLETED` | 200, read-back `COMPLETED` | same | still the only route to `COMPLETED` without a tracking number |
| Transaction Search scope | absent | **present** | fresh app (P-21) fixed it |
| Token lifetime | n/a | 30456 s / 32400 s | refresh window 5 min is far inside it |
| Revocation | not tested | `/token/terminate` 200 → next call 401 `invalid_token` | the forced refresh path works against real PayPal |
| Seller protection | not recorded | `NOT_ELIGIBLE` on card captures | INFERENCE: no shipping address on these orders; `risk_level_indicator: HIGH_RISK` in `supplementary_data` |

## Tests built on these fixtures

`pnpm --filter @cleared/adapters test`: 5 files, 47 tests, offline. The replay suite
(`src/paypal/orders.replay.test.ts`) drives the real adapter code through msw with
`onUnhandledFrame: "error"`, so an unrecorded request fails the test.
