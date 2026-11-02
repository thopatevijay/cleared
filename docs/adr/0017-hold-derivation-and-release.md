# 0017. Hold derivation: release edges, idempotency without a migration, the cited rule table

- Status: accepted
- Date: 2026-11-02
- Ticket: M3-01 (BL-01 6527422618)

## Context

M1-01 built the Hold machine exactly as architecture §2 drew it: `released` was reachable only from `filed`. In the sandbox the common path is that PayPal releases the hold by itself (payment review clears in 24 h; a dispute hold ends when the dispute resolves) while the hold is still `open` or `explained`. M3-01 also has to write each hold once per opening, even when events are replayed or arrive out of order, and to show every release date as an estimate with its source.

## Decision

1. **Release edges.** `capture_released` leads to `released` from every state except `released` itself, `still_held` included. `released` is set only when the mirrored capture leaves `PENDING` (never from a dispute event, a timer or an estimate).
2. **Derivation reads the mirror, not the event.** The holds consumer runs on `payment.captured`, `payment.status_changed` and `dispute.opened`. It reads the payment row as capture sync stored it (PayPal re-fetched), locks it (`SELECT … FOR UPDATE`), and reconciles: derived and no active hold → insert the hold and `hold.opened`; not derived and an active hold → `released` and `hold.released`; derived with a different reason → the active hold is updated in place (no event). The hold row and its outbox row are written in the consumer's one transaction. Replays find the same active hold, or nothing to release, and write nothing.
3. **No migration.** The row lock serialises reconciles per payment, so no unique index is needed; `holds.estimate_source` stores the rule id (`rules.ts`), whose row carries `source { url, quote, retrieved_at }`. The upper bound (payment review: 3 business days) is recomputed from the rule on read.
4. **Rule table.** `packages/core/src/holds/rules.ts` is versioned data (`HOLD_RULES_VERSION`). A test fails when a `capture_status_details.reason` in the vendored Orders spec enum has no row. A reason PayPal adds later falls back to the `OTHER` row with PayPal's string kept verbatim. Sample rows (`new_seller_21d`, `reserve`, `limitation`) are explainers only and can't be derived.

## Alternatives considered

- A unique index on `(payment_id, reason, opened_at)` (migration 0012). Rejected for now: two other M3 tickets may add 0012 in parallel, and the row lock already gives one writer per payment.
- Releasing a hold from `dispute.status_changed → RESOLVED`. Rejected: PayPal's capture status is the only proof the money is free.

## Consequences

- A hold whose reason changes (e.g. `PENDING_REVIEW` → `BUYER_COMPLAINT`) stays one hold; M3-08 gets no second `hold.opened` for it.
- `estimate_source` now means "rule id", not free text. M3-02 grounds explanations on that row.

## Addendum (M3-03, 2026-11-02): tracking before an explanation

- `open --action_proposed--> action_proposed` is added. A seller can file tracking on a goods hold before M3-02 has written an explanation; requiring `explained` first would block a seller action on an AI step.
- The tracking action drives the hold only when PayPal accepts it: on `add_tracking` success the worker walks the hold through `action_proposed → approved → filed` with `transitionHold` (skipping events the current state does not take) in the same transaction as the execution row, and sets `estimate_source = goods_delivered` with no date ("after the courier confirms delivery"). A rejected or failed tracking action leaves the hold where it was, so a new proposal is always possible.

## Addendum 2 (M3-04, 2026-11-02): the guided Completed step and the unconfirmed API record

- **The seller's web step drives the hold.** PayPal help129: "We'll release the hold 7 days after you confirm the order status as Completed." PayPal support (2026-10-26) named the web path (Activity → the payment → Completed) and said an API equivalence is "not available". When the seller confirms "I marked it Completed in PayPal" with a date (today → now; an earlier day → noon that day in the workspace zone; never before the hold opened, never in the future), the hold walks `action_proposed → approved → filed` with `transitionHold` (the same walk as a filed tracking action), `estimate_source = service_completed`, `estimated_release_at = confirmed + 7 days` and the new `holds.completed_confirmed_at`. The hold row, the seller audit row and the `hold.completed_confirmed` outbox row are one transaction. Only `service` holds in `open | explained | action_proposed | approved` can be confirmed, once.
- **The API record never drives the hold.** `record_service_completed` (legacy `POST /v1/shipping/trackers-batch`, status COMPLETED, no tracking number and no carrier: a carrier without a tracking number is refused live, 400 `TRACKING_NUMBER_IS_MISSING`, debug_id f168737fc6ae4) is a seller-approved action labelled "Effect on release unconfirmed". Its success, failure or reconcile changes neither the hold state nor the estimate. An `unknown` write is reconciled by reading `GET /v1/shipping/trackers/{capture}-NOTRACKER` back (never by resending: the v1 write has no PayPal-Request-Id, so the HTTP client never retries it).
- Migration 0015 adds the `action_kind` value and `holds.completed_confirmed_at`.
