# Fixtures: recorded real vendor exchanges

Tests replay these instead of calling vendors (data policy, `PROJECT.md` §9.1: no mocks in the product
path; tests replay recorded real responses). Every file here came from a live **sandbox** run through
the product adapters, and was scrubbed before it touched the disk.

## Format: one file per exchange

`fixtures/<vendor>/<area>/<name>.json`

```json
{
  "meta": { "recorded_at": "2026-10-29T04:57:08.267Z", "env": "sandbox", "ticket": "M0-04", "scrubbed": true, "note": "optional" },
  "request": { "method": "POST", "url": "https://…", "headers": { "content-type": "…" }, "body": {} },
  "response": { "status": 201, "headers": { "paypal-debug-id": "…" }, "body": {} }
}
```

- `meta.env` is `"sandbox"` (PayPal) or `"live"` for a vendor with no sandbox (`fixtures/openai/`, M0-07).
  OpenAI request bodies have inline base64 files elided to `data:<type>;base64,<elided N chars>`
  (`createRecorder({ transform })`); `fixtures/samples/evidence/` holds the source files.
- `body` is parsed JSON when the wire body was JSON, a (scrubbed) string otherwise (form bodies), and
  `null` when empty.
- **Headers are allow-listed**, never deny-listed. Request: `content-type`, `accept`, `prefer`,
  `paypal-request-id`. Response: `content-type`, `paypal-debug-id`, `retry-after`. Everything else
  (`Authorization`, cookies, OpenAI org/project headers) is dropped
  (`packages/adapters/src/testing/scrub.ts`).
- Several exchanges under one logical step get `.2`, `.3`… suffixes in call order
  (`errors/401-revoked-token.json` → `.2` = forced re-mint → `.3` = the retried call).

## Scrubbing (`createScrubber`)

| Removed (→ `[REDACTED]`) | Replaced with a stable placeholder | Kept (flow needs them) |
|---|---|---|
| token fields (`access_token`, `refresh_token`, `id_token`, `nonce`), the OAuth client-secret field, CVV, `Bearer …`/`Basic …`, `A21…` tokens, `sk-…` keys, and the exact client id / secret / live token strings | emails → `payer-N@example.test` / `merchant-N@example.test` (payee); names → `Person N`; `payer_id`/`merchant_id`/`account_id`/`app_id` → `PAYER-N`/`MERCHANT-N`/`ACCOUNT-N`/`APP-N`; address lines → `Address N`; phones → `PHONE-N`; IPv4 → `IP-N`; 13–19 digit runs (card numbers) → `CARD-N` | order, capture, tracker, dispute and debug ids; `custom_id`; amounts; statuses; HATEOAS links |

Placeholders are stable within one recording run: the same merchant is `MERCHANT-1` in every file.

## Recording

```bash
pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-a.ts --record   # needs PAYPAL_SANDBOX
```

The recorder (`createRecorder`) plugs into the shared HTTP client's `onExchange` hook, so recording
goes through exactly the code the product runs. A spike labels each step (`recorder.label("orders/create-goods-a")`).
`PAYPAL_ENV` must be unset or `sandbox`; the script refuses anything else.

## Replay

```ts
import { startReplay } from "../testing/replay.ts";
const replay = startReplay(["paypal/oauth/token", "paypal/orders/create-goods-a"]);
// … run the real adapter code …
expect(replay.unused()).toEqual([]);
replay.close();
```

msw serves each fixture **once**, matched on method + full URL (and `PayPal-Request-Id` when the
fixture recorded one), in the order listed. A request with no remaining fixture is unhandled and
**fails the test** (`onUnhandledFrame: "error"`); nothing reaches the network.

## Checks

The M0-04 Validation Gate (`.github/plan/M0-04-*.md`) greps this directory for credential-shaped
text, any email outside `@example.test`, any 13–19 digit run, and a fixture without
`meta.scrubbed == true`; each must find nothing. `scripts/landing-checks.sh` repeats the credential
grep on every run. (The patterns are not copied here, because this README would then match them.)

## Inventory

| Area | Files | Recorded by |
|---|---|---|
| `paypal/oauth` | `token`, `terminate-token` | M0-04 |
| `paypal/orders` | `create-goods-a`, `create-goods-a-replay`, `get-order-a`, `get-capture-a`, `create-goods-b`, `create-service-c` | M0-04 |
| `paypal/tracking` | `track-ind-delhivery`, `track-other`, `trackers-batch-completed`, `get-legacy-tracker` | M0-04 |
| `paypal/errors` | `400-validation`, `404-capture`, `401-revoked-token` (+`.2`, `.3`), `capture-already-captured` | M0-04 |
| `paypal/disputes/full` | chargeback → every distinct state (`state-N-<status>`) → `write-supporting-info`, `write-evidence`, `write-adjudicate` (each = re-check GET + `.2` write) → `capture-N-<status>` (hold and release) | M0-05 |
| `paypal/disputes/unknown` | chargeback, states, `guard-refused-evidence` (GET only: refused client-side), `before`, `timeout-precheck-get`, `after-timeout`, `retry-same-request-id-failed`, `after-retry`, `raw-retry-same-request-id` | M0-05 |
| `paypal/disputes/accept` | chargeback, states, `write-accept-claim`, `capture-N-<status>`, `later-<status>` / `later-capture-<status>` (re-read 25 min after) | M0-05 |
| `paypal/disputes/require` | evidence → `write-require-evidence` (sandbox) → `after` (back to `WAITING_FOR_SELLER_RESPONSE`, new deadline) | M0-05 |
| `paypal/disputes/idempotency` | the same `PayPal-Request-Id` sent twice while the link is present, then a re-read | M0-05 |
| `paypal/disputes/errors` | each write sent while its link is absent → PayPal's `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` | M0-05 |
| `paypal/disputes/list` | `update-time-after` (`listDisputes`) | M0-05 |
| `samples/evidence` | `delivery-note.pdf`: synthetic one-page PDF (`scripts/spikes/evidence-pdf.ts`) | M0-05 |

Dispute recordings: `pnpm tsx --env-file=<path to .env> scripts/spikes/paypal-b.ts --record` (≈ 20–45 min,
polls ≥ 60 s apart). Follow-ups: `--idempotency` (same request id twice), `--idempotency --raw-retry-only --dispute <id> --request-id <id> [--full-capture <id>] [--accept-dispute <id> --accept-capture <id>]`, and `--require-evidence --dispute <id>`.
Multipart bodies are recorded as text with each file's bytes replaced by `[type N bytes sha256:…]`.
