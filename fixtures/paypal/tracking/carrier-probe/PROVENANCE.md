# Carrier probe: provenance (M3-03 AC 1, 2026-11-02)

The full "Shipped by" capture (`packages/core/data/carriers/shipped-by-dropdown.json`, 834 codes) had 9
codes that PayPal's published carrier page lacks. This run asked the sandbox track API about each one.

- **Script.** `scripts/spikes/m3-03-carrier-probe.ts`, run with the main checkout's `.env` loaded by path
  (the local launcher), then once more with `--verify`. It goes through the product adapters: the shared HTTP
  client and `PayPalOrdersClient.trackOrder`, the same call and body as the `add_tracking` action.
- **Payment.** One owned test payment (`createOwnedTestPayment`, card order, `custom_id` = a synthetic
  workspace id as in `m1-04-test-payment.ts`; no database): order `5PK45642M3832004P`, capture
  `82D672095U929030G`. Its webhooks reach the Render app, which quarantines it as unowned (BL-01
  6568286398). That's expected.
- **Calls.** Each code got `POST /v2/checkout/orders/{id}/track` with a dummy `CLRPROBE…` tracking number
  and `notify_payer: false`. An `IND_DELHIVERY` control went first. Then `--verify` read each tracker
  back with `GET /v1/shipping/trackers/{capture}-{number}` (`*-get.json`) and sent one negative control.
  In all: 14 calls in the probe run (OAuth, create, confirm, capture, 10 tracks) and 12 in the verify run
  (OAuth, 10 GETs, 1 track). Cost $0 (sandbox).
- **Recorded.** Only the track and read-back exchanges, scrubbed by `createRecorder` (fixtures/README.md).
  `results.json` summarises the run.

| Code | Track status | debug_id | Stored carrier (read-back) |
|---|---|---|---|
| `IND_DELHIVERY` (control) | 201 | `f945378bbb0f4` | `IND_DELHIVERY` |
| `_2EBOX` | 201 | `f1004920a1b33` | `_2EBOX` |
| `_360LION` | 201 | `f6370968aa085` | `_360LION` |
| `_3JMSLOGISTICS` | 201 | `f95073268e45e` | `_3JMSLOGISTICS` |
| `_4_72` | 201 | `f643330fcd9ba` | `_4_72` |
| `_6LS` | 201 | `f648177a107d9` | `_6LS` |
| `BEL_DHL` | 201 | `f995548bea25e` | `BEL_DHL` |
| `GLS_ITALY` | 201 | `f4904818bdf60` | `GLS_ITALY` |
| `JITSU` | 201 | `f8119415e302a` | `JITSU` |
| `SKYEXPRESS_INTERNATIONAL` | 201 | `f965748fd1edb` | `SKYEXPRESS_INTERNATIONAL` |
| `CLEARED_NOT_A_CARRIER` (negative control) | 400 `INVALID_REQUEST` / `INVALID_PARAMETER_VALUE` | `f9460114c83d6` | none |

**Reading.** The track API validates `carrier`: a code on no list gets a 400. It accepted all 9 dropdown
codes and stored each one verbatim. So all 9 are valid PayPal carrier enums that the published page
doesn't list. They are added to `packages/core/data/carriers/api-carriers.json` with
`source: "sandbox-track-probe"` and the debug_id above. None was rejected, so AC 1's exception list is
empty. This is sandbox only; live accounts may differ (the tier caveat already says so).
