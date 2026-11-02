# 0019. Review-hold pool and ownership transfer

- Status: accepted
- Date: 2026-11-02
- Ticket: M3-10

## Context

A real `PENDING / PENDING_REVIEW` hold needs a PayPal-wallet order that a buyer approves in a browser,
and it releases about 24 h after capture. The API-only judge path can't make one, so the owner pre-stages
a pool of such payments. Each payment has to reach exactly one judge (or the owner's recording workspace)
later, after it was captured. ADR 0008 makes `paypal_resource_owner` the source of truth and `custom_id`
a cross-check; PayPal can't change a captured order's `custom_id`, so it keeps naming the pool workspace.

## Decision

- A dedicated **pool workspace** (kind `seller`, no user, `llm_budget_usd 0`) owns every pool order:
  `custom_id` = its id, and `paypal_resource_owner` rows are written when the order is created.
  Table `review_hold_pool` (platform) tracks each order: `purpose` (`judge` | `video`), `state`
  (`awaiting_buyer` → `held` | `not_held`; `held` → `released`), the capture id and PayPal's status and
  reason verbatim, `captured_at`, and `assigned_workspace_id` / `assigned_at`.
- **Assignment** runs in one transaction: lock one candidate (`FOR UPDATE SKIP LOCKED`), re-check it
  (pool-owned, `held`, unassigned, mirror still `PENDING`, `now − captured_at < 20 h`), then move the
  order and capture owner rows (`workspace_id` = target, `transferred_from` = pool workspace), and the
  `payments`, `holds` and `explanations` rows, and write the `pool.assigned` audit entry on the target.
  Two concurrent assignments never get the same row.
- **Ownership check.** `paypal_resource_owner.transferred_from` records the workspace a row moved from.
  `resolveOwner` accepts `custom_id` equal to the owner **or** to `transferred_from`; any other value is
  still a mismatch. A child claimed on ingest (a dispute on a moved capture) inherits `transferred_from`.
- A released pool row (`COMPLETED`) stays as a released example and is never assigned as held.

## Alternatives considered

- Re-creating the payment in the judge workspace: the capture id is unique, and the hold's history would
  split across two rows.
- Ignoring `custom_id` for pool resources: weakens the ADR 0008 cross-check for every resource.
- A pool per judge: needs a buyer approval per judge, which is the problem the pool solves.

## Consequences

One nullable column on `paypal_resource_owner` and one platform table. A moved payment's
notifications and agent runs from its pool time stay in the pool workspace (nobody can sign into it).
Reversal cost: low.
