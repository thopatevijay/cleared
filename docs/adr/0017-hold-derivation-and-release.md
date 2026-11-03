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

## Addendum 3 (BL-01 6570499264, 2026-11-03): the seller declares goods or service; release rules follow PayPal's type only

**Context.** `deriveHold` maps PayPal's `status_details.reason` to `review | dispute | other`; PayPal never says whether a held payment was goods or a service, and the sandbox can't produce the new-seller goods/service holds help129's rules describe (help848). So route advice + "File tracking" (M3-03) and the guided Completed step (M3-04) never showed on a real payment. The research note on #35 (sandbox control test, n = 2): a `PENDING_REVIEW` hold released at 24 h 0 m with and without tracking, so the delivery and Completed rules don't describe a review hold. Owner decision 2026-11-03 (#43): **option A, the seller declares**.

**Decision.**
1. **The declaration is the seller's, never PayPal's.** `holds.seller_declared_kind` (`goods | service`, check constraint), `seller_declared_by` (the session actor) and `seller_declared_at` (migration 0018), set by `POST /api/holds/:id/declaration` in one transaction with a `hold.declared` seller audit row (`from`, `to`, PayPal's `reason`, `by`), under the payment's row lock. It is a Cleared field: the hold's `type`, `reason`, state and estimate are not touched, and no PayPal state is invented. The UI always words it as the seller's answer ("You marked this as goods") and says PayPal's estimate stands.
2. **It only selects the guided action.** `guidedAction(type, declared)` (core): PayPal's type wins (`goods` → tracking, `service` → Completed, `sample` → none); otherwise the declaration picks it; undeclared → none. Tracking and the API Completed record stay seller-approved actions bound to the payload sha256, exactly as in M3-03/M3-04. The proposal routes re-check the guided action under the payment's row lock.
3. **The hard rule: a release rule follows PayPal's type, never the declaration.** `releaseRuleAfterAction(type, action)` returns `goods_delivered` only for tracking on a hold PayPal typed `goods`, `service_completed` only for Completed on a hold PayPal typed `service`, and `null` for everything else. The worker's `fileHold` (tracking success / reconcile) and `confirmCompleted` (the guided web step) both go through it. So on a `PENDING_REVIEW` hold (or a dispute hold, or any other reason) the estimate stays PayPal's rule for that reason (`payment_review`: about 24 h, up to 3 business days) after the declaration, after filed tracking and after the Completed confirmation. The "about 24 h after delivery" and "7 days after Completed" estimates, and every release-speed phrase (`trackingHelps`, `tier.approved`, "Approved carriers for a faster release", help129's 7-day intro), are shown only where PayPal typed the hold; a declared hold gets neutral copy (`holds.tracking.neutral.*`, `holds.completed.introDeclared`).
4. **A declared-only Completed confirmation** walks the hold to `filed`, stores `completed_confirmed_at` and writes the seller audit row (`estimateChanged: false`), but emits no `hold.completed_confirmed`: that event carries the 7-day estimate M3-08's reminder keys on, which doesn't apply. The route answers `{ estimatedReleaseAt: <PayPal's estimate>, estimateChanged: false }`.
5. **Changeable until approved.** Locked (409 `DECLARATION_LOCKED`) once the hold is past approval (`approved | filed | still_held | released`), the Completed step was confirmed, or the newest `add_tracking` / `record_service_completed` on the capture reached `approved | executing | succeeded | failed | unknown`. Changing it rejects a still-`proposed` action of the other kind (audit `action.rejected`, `reason: declaration_changed`); if that action was approved meanwhile, the change is refused. Declarable only on unreleased `review | dispute | other` holds (409 `NOT_DECLARABLE` otherwise). A new hold row on the same payment starts undeclared.

**Proof.** `packages/core/src/holds/declaration.test.ts` (every PayPal reason row × both declarations → no delivery/Completed rule; PENDING_REVIEW declared service → Completed confirmed with `estimate: null`), `apps/web/app/api/holds/declaration.int.test.ts` (the hold reads `payment_review` and PayPal's estimate after declare, propose, approve and confirm), the worker's recorded-fixture tests (`add_tracking` 201 debug_id f345140fb0d0d and `record_service_completed` 200 debug_id f529566754294 on declared review holds: estimate unchanged), and `apps/web/src/components/holds/declaration.test.tsx` (no release-speed copy on a declared review hold).

**Alternatives.** B (labelled sample holds) and C (order item `category`) from #43: B shows no real PayPal write; C has no service category and misses a judge's own payment.
