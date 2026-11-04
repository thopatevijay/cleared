# M5-02 · Demo video: staging record

Live staging on **production** (`https://cleared-web-gd1b.onrender.com`, Render, Oregon) against the **PayPal
sandbox**. Every id below is a sandbox id. No secret, token or credential appears here. Commands follow
[docs/runbooks/review-hold-pool.md](../runbooks/review-hold-pool.md) and ran over `render ssh` on
cleared-worker (production's own environment), as in M3-11 and M3-GATE.

## 1. Review-hold payment (scene 3, 0:45–1:05)

| Step | When (UTC) | Who | Result |
|---|---|---|---|
| `pool.ts status` before creating | 2026-11-04 ~13:45 | M5-02 session | 3 rows: 2 `released`, 1 `held` (`0AC26844K1160484H`, already assigned to the M3-GATE workspace). No assignable row |
| `pool.ts create --count 1 --purpose video` | **2026-11-04 13:46:27** | M5-02 session | order **`0EF30632BL321560C`**, 64.00 USD; OAuth 200 (`debug_id ca554109bbaf2`), create-order 200 (`debug_id ca554109c9caf`) |
| `pool.ts status` | 2026-11-04 ~13:47 | M5-02 session | `video awaiting_buyer 0EF30632BL321560C` |
| Buyer approval (P-52) | _pending_ | owner | open https://www.sandbox.paypal.com/checkoutnow?token=0EF30632BL321560C as the sandbox Personal account → Approve |
| `pool.ts capture` | _pending_ | next session | expect capture `PENDING / PENDING_REVIEW`, row `held` |
| `pool.ts assign --workspace <recording workspace>` | _pending_ | next session | the recording workspace gets the hold |

### Timing window (from the M3-10 handoff and the runbook)

PayPal releases a review hold about 24 h after **capture** (an estimate, rule `payment_review`; the stated
upper bound is 3 business days), and `pool:assign` takes a row only while it is **under 20 h old**. So the
clock that matters starts at `pool.ts capture`, not at order creation:

- **Capture** right after the owner approves (the runbook says approve soon after creating; PayPal can
  expire an order nobody approves).
- **Assign** before capture + 20 h.
- **Record scene 3** while the capture is still `PENDING / PENDING_REVIEW`: before about capture + 24 h. Check
  `pool.ts status` first, because PayPal may release earlier.
- **Earliest recording:** any time after capture + assignment (the hold shows within minutes). If the
  recording slips past capture + 20 h unassigned, create and approve a new row (one `pool.ts create` away).

| | Value |
|---|---|
| Order created | 2026-11-04T13:46:27Z |
| Approved by the owner | _to fill_ |
| Captured (`captured_at`) | _to fill_ |
| Assign by (capture + 20 h) | _to fill_ |
| Record scene 3 before (≈ capture + 24 h, estimate) | _to fill_ |

## 2. Chargeback (scene 4, 1:05–1:50)

Not staged yet. Stage it about **20 minutes before recording**, in the recording workspace, with the M2-10
dispute scenario (the $120 card payment). The M3-11 run measured: dispute webhook ~3 min, draft ~1 min,
filing 9 s, decision control unlocks ~4 min after filing, resolution ~6 min after the decision. Record the
order, capture, dispute id and `debug_id`s here.

| Item | Id |
|---|---|
| Recording workspace | _to fill_ |
| Scenario run | _to fill_ |
| $120 card order / capture | _to fill_ |
| Dispute | _to fill_ |
| Evidence filing `debug_id` | _to fill_ |
| Decision (`adjudicate`) `debug_id` | _to fill_ |

Every id used on camera must be listed by `pnpm audit:find --paypal-id <id>` against production (AC 2).
