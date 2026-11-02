# Runbook: review-hold pool (M3-10, ADR 0019)

A real `PENDING / PENDING_REVIEW` hold needs a PayPal-wallet payment that a buyer approves in a browser.
The sandbox business account has Payment Review enabled (proven 2026-10-26 and 2026-10-28). PayPal
releases the hold about 24 h after capture. The API-only judge path can't make one, so the owner
pre-stages a small pool:

| Pool | Size | When to create it | Who gets it |
|---|---|---|---|
| `video` | 1 | about 24 h before recording (M3-11 dry run, M3-GATE, M5-02) | the owner's recording workspace, via `pool:assign` |
| `judge` | 2 | before a judging window (refills Dec 1–15: M4-07) | each new "Try as demo seller" workspace, automatically |

## Timing

- **Approve soon after creating.** PayPal can expire an order that nobody approves; if an approval link
  no longer works, create a new order.
- **The hold appears** a few minutes after approval, once `pool:capture` has captured the order.
- **It releases** about 24 h after capture (rule `payment_review`: "PayPal reviews the transaction for up
  to 24 hours"; the stated upper bound is 3 business days). This is an estimate, not PayPal's promise.
- **Judges get a row only while it is under 20 h old**, so a judge sees at least a few hours of hold.
  An older row, or one PayPal released (`COMPLETED`), is never assigned again; released rows stay in
  `pool:status` as released examples.
- With no assignable row, the demo workspace's held-money inbox shows the badged explainer "Review holds
  need a buyer approval; see README for timing".

## Steps

Run every command from the repo root against the target database (`DATABASE_URL`), with the PayPal
sandbox credentials in the environment (local: the WORKFLOW.md launcher; never copy `.env`). The CLI
prints ids, states and approval URLs only, never a token or secret.

1. **Create** (`--count` is 1 to 5):
   ```bash
   pnpm --filter ./apps/worker run pool:create -- --count 1 --purpose video
   pnpm --filter ./apps/worker run pool:create -- --count 2 --purpose judge
   ```
   Each line is `<order id>  <amount>  <approval URL>`. `pool:status -- --urls` prints them again.
2. **Approve (owner, P-52).** Open each approval URL in your own browser, log in as the **sandbox
   Personal (buyer) account** and approve. The credentials stay in your browser: never paste them into
   the repo, the CLI or a chat.
3. **Capture** (any time after approval; safe to re-run):
   ```bash
   pnpm --filter ./apps/worker run pool:capture
   ```
   Approved orders are captured with the pool row id as `PayPal-Request-Id` (a re-run replays PayPal's
   first answer). A capture that is `PENDING / PENDING_REVIEW` becomes `held`; anything else is
   `not_held` and is not retried. It also re-reads every `held` row and marks the ones PayPal released.
   The payment and its hold arrive through the worker (the `paypal.capture.sync` job it enqueues), so
   the worker must be running on the same database.
4. **Check**:
   ```bash
   pnpm --filter ./apps/worker run pool:status
   ```
   One line per row: purpose, state, order, capture, PayPal's status/reason, age since capture, the
   estimated release (`~capture + 24 h`), and the workspace it was assigned to.
5. **Video only: assign** to the recording workspace:
   ```bash
   pnpm --filter ./apps/worker run pool:assign -- --workspace <workspace uuid>
   ```
   Exit 1 when no video row is assignable (create and approve one, then capture).

## What the assignment does

One transaction: lock one candidate (`FOR UPDATE SKIP LOCKED`, so two judges never share one), move the
order and capture rows of `paypal_resource_owner` to the target (`transferred_from` = pool workspace),
move the payment, its hold and explanation rows, mark the pool row assigned, and write the
`pool.assigned` audit entry on the target workspace. The capture's `custom_id` still names the pool
workspace (PayPal can't change it); ingest accepts it through `transferred_from` (ADR 0019).

## Queries

```sql
select purpose, state, order_id, capture_id, capture_status, capture_reason, captured_at, assigned_workspace_id
from review_hold_pool order by created_at desc;
```
