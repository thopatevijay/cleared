# M0-06 evidence: PayPal spike C (webhooks) in TypeScript

- **Runs (2026-10-29, UTC):**
  - Run 1, 06:08:24–06:15:08: `pnpm tsx --env-file=<main checkout>/.env scripts/spikes/paypal-c.ts --url <tunnel> --record`.
    - It exited 1 at `listWebhookEvents`: PayPal answers 400 `VALIDATION_ERROR` "Datetime needs to be in the ISO 8601 format specified in RFC 3339 section 5.6" to `start_time` with milliseconds. The `finally` block still deleted the spike webhook. The fix is `rfc3339()` in `webhooks.ts`, which strips fractional seconds and is unit-tested.
    - Its fixtures were discarded and its latency numbers are kept below.
  - Run 2, 06:15:56–06:22:54: the same command, exit 0. It produced every fixture except `url-*`.
  - Probe, 06:24: `… paypal-c.ts --url <tunnel> --record --simulate-url-only`, which sent one simulator event by `url` with no webhook registered (exit 0).
- **Environment:** PayPal **sandbox** (`api-m.sandbox.paypal.com`) with the project sandbox app (P-21); `PAYPAL_ENV` was unset.
- **Spend:** $0 (sandbox; no OpenAI calls).
- **Transport:**
  - `scripts/spikes/webhook-receiver.ts` (Node `http`, `127.0.0.1:8180` = 8080 + `PORT_OFFSET` 100) writes each delivery's raw bytes and `paypal-*` headers to `$TMPDIR/m0-06/`, then answers 200.
  - A `cloudflared` quick tunnel (no account; `https://<random>.trycloudflare.com`, HTTPS 443) exposes the receiver.
  - The webhook URL was `<tunnel>/api/webhooks/paypal`.
- **Code path:**
  - Management calls: `createHttpClient` → `createTokenProvider` → `createPayPalWebhooksClient`.
  - Capture: `createPayPalOrdersClient` (M0-04 helper). Chargeback: `createPayPalDisputesClient.processChargeback` (M0-05).
  - Verification: `createWebhookVerifier` (cert fetch on a separate shared-client instance, `redirect: "manual"`) and `verifyViaApi`.

## Webhooks on the app (before and after)

| When | `GET /v1/notifications/webhooks` |
|---|---|
| Before run 1 and before run 2 | `[]` (0 webhooks) |
| After `ensureWebhook` ×2 (run 2) | 1 webhook: the spike URL, id `9H93406745674050R` |
| After `deleteWebhook` (runs 1 and 2, probe) | `[]` (0 webhooks), `spikeGone: true` |

The **webhook lookup** created in run 1 (`9AA71399651744351`) stays on the app. It is account-level and not tied to a URL, PayPal allows one per app, and M1-04 needs it. Run 2's `ensureWebhookLookup` found it and returned `unchanged`, so no second lookup was created.

## AC evidence

### AC 1: real deliveries, both verifications valid

**Run 2:** capture `0M327451J9579884Y` (order `90J43999BW241705J`, USD 37.00); dispute `PP-R-YKI-10195086`.

| Event (real) | Event id | Self-verify on arrival (real clock) | Self-verify (clock pinned to receive time) | Verify API |
|---|---|---|---|---|
| `PAYMENT.CAPTURE.COMPLETED` | `WH-2CK67944VL911102K-0RL32799TA7321821` | **SUCCESS** (1.07 s after receipt) | SUCCESS | **SUCCESS** |
| `CUSTOMER.DISPUTE.CREATED` | `WH-5WD9164028571322G-17G30127FJ447530Y` | **SUCCESS** (1.79 s after receipt) | SUCCESS | **SUCCESS** |
| `CUSTOMER.DISPUTE.UPDATED` | `WH-3XN51907WT607083P-68J828049H6368801` | n/a | SUCCESS | **SUCCESS** |

Run 1 (capture `50Y299496A724243D`, dispute `PP-R-EXT-10195083`): self-verify on arrival was SUCCESS for both. The API was not called, because the run stopped before that step.

How the verifications ran:

- **Verify API:** `POST /v1/notifications/verify-webhook-signature`, with the event spliced in as the raw text (`verifyRequestBody`; the fixture is `management/verify-signature`).
- **Cert URL** in every delivery (real and simulated): `https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596`. It passed the allowlist.
- **Headers PayPal sends:**
  - `paypal-auth-algo: SHA256withRSA`, `paypal-auth-version: v2`, `paypal-cert-url`, `paypal-transmission-{id,sig,time}`;
  - `content-type: application/json`, `user-agent: PayPal/AUHD-1.0-1`.

### AC 2: `ensureWebhook` idempotent; spike webhook deleted

- **Actions, run 2:** `ensureWebhook(url, 9 types)` returned `created`, then `unchanged` on the same id. Exactly one webhook had the URL afterwards.
- **PATCH round trip:** with one type fewer it returned `patched`, and with the full set `patched` again. Each PATCH is a single `replace /event_types`.
- **Cleanup:** `deleteWebhook` returned 204 → `true`, and `listWebhooks` was then `[]`.
- **Replay proof:** `webhooks.replay.test.ts` (`ensureWebhook` twice: one create then a no-op; PATCH each way; before 0 / after ensure 1 / after delete 0).

### AC 3: simulator fixture verifies offline with its real signature

`webhook-verify.replay.test.ts` runs over 10 byte-for-byte simulator deliveries:

- each verifies with its signing webhook id, with one cert fetch served from the fixture's `cert_pem` and then cached;
- **flipping one body byte gives `bad_signature`**;
- re-serialising the same JSON gives `bad_signature`;
- another webhook id gives `bad_signature`.

**Which webhook id signs a simulator event (measured):**

| `simulate-event` addressed by | Verifies with `WEBHOOK_ID` | Verifies with the target webhook's id |
|---|---|---|
| `webhook_id` (9 types, run 2) | **no** (`bad_signature` ×9) | **yes** ×9 |
| `url`, no webhook registered (probe) | **yes** | n/a |

PayPal's integrate guide says the mock id is `WEBHOOK_ID`. That holds only for url-addressed simulations (BL-01 6489621772). Each fixture records `meta.signed_webhook_id`.

`PAYMENT.CAPTURE.DECLINED` returns 400 `VALIDATION_ERROR` "Not a valid Resource Type" at the default resource version. It is simulated with `resource_version: "2.0"` (run 2), and the run-1 failure is recorded in the run-1 summary.

### AC 4: re-signed delivery fixtures

The 3 scrubbed real deliveries are re-signed with a 2048-bit RSA pair generated in the test. Each verifies with no network call, and each fails as expected:

- wrong webhook id → `bad_signature`;
- transmission time more than 5 min from now → `stale_transmission_time`;
- one byte flipped → `bad_signature`.

### AC 5: cert host allowlist, no network call

`webhook-verify.test.ts` uses a counting fetch, which records **0 calls** for each of these rejected URLs:

| Cert URL | Reason |
|---|---|
| `http://…` | `cert_url_not_https` |
| `https://api.paypal.com.evil.test/…` | `cert_host_not_allowed` |
| `https://151.101.1.1/…` | `cert_host_ip_literal` |
| `https://[::1]/…` | `cert_host_ip_literal` |
| `https://localhost/…` | `cert_host_not_allowed` |
| `api-m.sandbox.paypal.com`, a subdomain, an explicit port, credentials, a trailing dot | `cert_host_not_allowed` |
| `file:` | `cert_url_not_https` |
| garbage | `cert_url_invalid` |

**Redirect:** an allowed host answering 302 → `http://169.254.169.254/…` produces exactly **one** call, made with `redirect: "manual"`. The result is `cert_fetch_failed`, and the redirect target is never fetched.

The shared client gained an optional `redirect` field, whose default `"follow"` is unchanged. A non-PEM body gives `cert_invalid` and is not cached.

### AC 6: measurements

**Delivery latency, real events:**

| Event | Run 1 | Run 2 |
|---|---|---|
| `PAYMENT.CAPTURE.COMPLETED`: capture response → received | 10.5 s | 17.4 s |
| `PAYMENT.CAPTURE.COMPLETED`: event `create_time` → received | 7.1 s | 13.9 s |
| `CUSTOMER.DISPUTE.CREATED`: chargeback response → received | 196.0 s | 184.4 s |
| `CUSTOMER.DISPUTE.CREATED`: event `create_time` → received | 7.2 s | 1.8 s |
| `CUSTOMER.DISPUTE.UPDATED`: event `create_time` → received | 1.2 s | 1.7 s |

- **The dispute event is late because PayPal emits it late.** `CUSTOMER.DISPUTE.CREATED` is created about 3 min after the chargeback, when the dispute is already `UNDER_REVIEW`:
  - the dispute's `create_time` is 06:16:30.460; the event's is 06:19:33.4;
  - the event's resource has status `UNDER_REVIEW` and links `provide_supporting_info`.
- **`CUSTOMER.DISPUTE.UPDATED`** follows at about +4 min with `WAITING_FOR_SELLER_RESPONSE` and links `accept_claim` / `provide_evidence`, which matches M0-05's timeline.
- **No `PAYMENT.CAPTURE.PENDING` arrived for the hold** within 6 min in either run (BL-01 6489621553).

**Simulator latency** (simulate response → received): 2.1–3.5 s across 18 deliveries (run 2: 2065–3481 ms).

**Self-verify time:**

| Case | Time |
|---|---|
| Cold (first call: cert fetched from PayPal through the shared client) | 926–948 ms |
| Warm cache, on arrival | 1.7–2.0 ms |
| **Warm cache, 200 runs over a real delivery** | **median 0.065 ms, p95 0.159 ms, max 0.87 ms** (target < 50 ms: met) |

### AC 7: scrub checks

- `grep` for emails outside `@example.test` in `deliveries/` and `management/` finds 0.
- 13–19 digit runs: 0. `PRIVATE KEY` under `fixtures/`: 0. `A21…` tokens: 0.
- The client id and secret go into the `[REDACTED]` slot (e.g. `lookup-list` `client_id`).
- Dispute `seller.name` / `merchant_id` → `Person N` / `MERCHANT-N`.
- The app had no webhooks besides the spike's, so no foreign webhook id is in any fixture.

## PayPal APIs exercised (real calls)

| API | Call | Result |
|---|---|---|
| Webhooks v1 | `GET /v1/notifications/webhooks` | 200 `{webhooks:[]}` / 1 item |
| Webhooks v1 | `POST /v1/notifications/webhooks` `{url, event_types:[{name}…9]}` | 201 |
| Webhooks v1 | `PATCH /v1/notifications/webhooks/{id}` `[{op:replace, path:/event_types, value}]` | 200 + the webhook |
| Webhooks v1 | `DELETE /v1/notifications/webhooks/{id}` | 204 |
| Webhooks v1 | `GET` / `POST /v1/notifications/webhooks-lookup` | 200 `{webhooks_lookups:[{id, client_id, links}]}` / 201 (run 1) |
| Webhooks v1 | `POST /v1/notifications/simulate-event` `{webhook_id \| url, event_type, resource_version?}` | 202 + the sample event |
| Webhooks v1 | `GET /v1/notifications/webhooks-events?page_size=50&start_time=<RFC 3339, no fraction>` | 200; the 3 real events (simulator events are not listed) |
| Webhooks v1 | `POST /v1/notifications/verify-webhook-signature` | 200 `{verification_status: SUCCESS}` ×3 |
| Cert | `GET https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-bf9ab596` | 200 PEM (2562 chars) |
| Orders v2 / Customer Support | card order (`COMPLETED` at create); `process-chargeback` (sandbox) | as in M0-04 / M0-05 |

## Limits of this evidence

- **No certificate chain check.** Trust in the signing cert rests on TLS to an allowlisted PayPal host with redirects refused, as in ADR 0012.
- **2 runs, sandbox only.** The latencies are point measurements, not a distribution.
- **The real-delivery fixtures no longer carry PayPal's signature.** Scrubbing breaks it, so they are re-signed in tests.
