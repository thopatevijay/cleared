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
