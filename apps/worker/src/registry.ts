// The one place consumers are registered (M1-03). Each entry is a queue (created with its `.dlq`) and
// its idempotent handler; `boss.ts` wires every entry with the same concurrency, retry and DLQ policy.
// Queue specs come from @cleared/db (`KNOWN_QUEUES`), which `migrate` also creates (M1-04).
// M2 and M3 add theirs here. One entry per queue (test/registry.test.ts): a second consumer of a queue
// that already has one (`pack.checked`, `dispute.*` run the M2-07 draft) composes with it inside that
// entry, running both idempotent handlers, and never replaces it (BL-01 6538667217).
import { correlationIdOrNew } from "@cleared/adapters";
import {
  ACTION_EXECUTE_QUEUE,
  ACTION_RECONCILE_QUEUE,
  createPublisher,
  NOTIFICATION_SEND_EMAIL_QUEUE,
  PAYPAL_CAPTURE_SYNC_QUEUE,
  PAYPAL_DISPUTE_SYNC_QUEUE,
  queueSpec,
  SANDBOX_TEST_PAYMENT_QUEUE,
  SCENARIO_CAPTURE_QUEUE,
  SCENARIO_CHARGEBACK_QUEUE,
  SCENARIO_DECIDE_QUEUE,
  SCENARIO_POLL_QUEUE,
  SCENARIO_SEED_PACK_QUEUE,
  SCOPE_SNAPSHOT_RENDER_QUEUE,
  type Db,
  type Queue,
} from "@cleared/db";
import type { AiRuntime } from "./ai.ts";
import type { Handler } from "./consume.ts";
import { disputeOpenedHandler, holdOpenedHandler } from "./consumers/notifications.ts";
import type { EmailRuntime } from "./email.ts";
import { sendEmailHandler } from "./jobs/send-email.ts";
import { holdsHandler } from "./consumers/holds.ts";
import { captureSyncHandler } from "./jobs/capture-sync.ts";
import { killSwitchFromEnv } from "./jobs/action-runtime.ts";
import { disputeSyncHandler } from "./jobs/dispute-sync.ts";
import { draftDisputeHandler } from "./jobs/draft-dispute.ts";
import { explainHoldHandler } from "./jobs/explain-hold.ts";
import { executeActionHandler } from "./jobs/execute-action.ts";
import { reconcileActionHandler } from "./jobs/reconcile-action.ts";
import { checkScopeHandler } from "./jobs/check-scope.ts";
import { extractEvidenceHandler } from "./jobs/extract-evidence.ts";
import { renderScopeSnapshotHandler, snapshotOnAckHandler } from "./jobs/render-scope-snapshot.ts";
import { testPaymentHandler } from "./jobs/test-payment.ts";
import { scenarioCaptureHandler } from "./jobs/scenario/capture.ts";
import { scenarioChargebackHandler } from "./jobs/scenario/chargeback.ts";
import { scenarioDecideHandler } from "./jobs/scenario/decide.ts";
import { scenarioPollHandler } from "./jobs/scenario/poll.ts";
import { scenarioSeedPackHandler } from "./jobs/scenario/seed-pack.ts";
import type { ScenarioDeps } from "./jobs/scenario/shared.ts";
import type { PayPalClients } from "./paypal.ts";
import type { QueueSpec } from "./queues.ts";

export interface Registration {
  readonly queue: QueueSpec;
  readonly handler: Handler;
}

export type Registry = readonly Registration[];

/** What handlers are built from, once the worker has its pool and pg-boss. */
export interface Runtime {
  readonly db: Db;
  readonly boss: Queue;
}

/** The production registry. The outbox relay is not listed: `boss.ts` schedules it on every worker. */
export function defaultRegistry(
  rt: Runtime,
  paypal: PayPalClients,
  ai: AiRuntime,
  email: EmailRuntime,
): Registry {
  const publisher = createPublisher(rt.db, rt.boss, correlationIdOrNew);
  const notifications = { db: rt.db, publisher };
  const scenario: ScenarioDeps = {
    db: rt.db,
    publisher,
    orders: paypal.orders,
    captures: paypal.captures,
    disputes: paypal.disputes,
    now: () => new Date(),
  };
  // M2-07: a dispute with an evidence action and a checked pack gets a draft + proposal (seller approves)
  const draft = draftDisputeHandler({ db: rt.db, ...ai, disputes: paypal.disputes, now: () => new Date() });
  // M3-01: derive or release the payment's hold from the mirrored capture
  const holds = holdsHandler({ db: rt.db, publisher, now: () => new Date() });
  // M3-07: the scope snapshot PDF (seller request, or a client's acknowledgement arriving)
  const snapshot = { db: rt.db, publisher, now: () => new Date() };
  // M3-02: explain a hold (explain_hold@v2, or the standard text) in the workspace's or the asked locale
  const explain = explainHoldHandler({ db: rt.db, publisher, ...ai, now: () => new Date() });
  return [
    {
      queue: queueSpec(PAYPAL_CAPTURE_SYNC_QUEUE),
      handler: captureSyncHandler({
        db: rt.db,
        publisher,
        captures: paypal.captures,
        now: () => new Date(),
      }),
    },
    {
      queue: queueSpec(PAYPAL_DISPUTE_SYNC_QUEUE),
      handler: disputeSyncHandler({
        db: rt.db,
        publisher,
        disputes: paypal.disputes,
        now: () => new Date(),
      }),
    },
    // M2-08: the governed write path (approve → execute → unknown → reconcile).
    {
      queue: queueSpec(ACTION_EXECUTE_QUEUE),
      handler: executeActionHandler({
        db: rt.db,
        publisher,
        disputes: paypal.disputes,
        orders: paypal.orders, // M3-03 add_tracking
        completed: paypal.orders, // M3-04 record_service_completed
        now: () => new Date(),
        killSwitchEnv: () => killSwitchFromEnv(process.env),
      }),
    },
    {
      queue: queueSpec(ACTION_RECONCILE_QUEUE),
      handler: reconcileActionHandler({
        db: rt.db,
        publisher,
        disputes: paypal.disputes,
        orders: paypal.orders,
        completed: paypal.orders, // M3-04 record_service_completed read-back
        now: () => new Date(),
      }),
    },
    {
      queue: queueSpec(SANDBOX_TEST_PAYMENT_QUEUE),
      handler: testPaymentHandler({ db: rt.db, orders: paypal.orders }),
    },
    // M2-03: extract facts from each new evidence item; M2-04: check the pack's scope once every item is extracted.
    // M3-07: a `client_ack` item then refreshes the scope snapshot (Cleared's records skip the AI: ADR 0018).
    {
      queue: queueSpec("evidence.added"),
      handler: inOrder(
        extractEvidenceHandler({ db: rt.db, publisher, ...ai, now: () => new Date() }),
        snapshotOnAckHandler(snapshot),
      ),
    },
    { queue: queueSpec(SCOPE_SNAPSHOT_RENDER_QUEUE), handler: renderScopeSnapshotHandler(snapshot) },
    {
      queue: queueSpec("pack.extracted"),
      handler: checkScopeHandler({ db: rt.db, publisher, ...ai, now: () => new Date() }),
    },
    // M2-07: a checked pack drafts for the open disputes on its payment.
    { queue: queueSpec("pack.checked"), handler: draft },
    // M2-10: the judge dispute scenario's steps and its sandbox decision.
    { queue: queueSpec(SCENARIO_CAPTURE_QUEUE), handler: scenarioCaptureHandler(scenario) },
    { queue: queueSpec(SCENARIO_SEED_PACK_QUEUE), handler: scenarioSeedPackHandler(scenario) },
    { queue: queueSpec(SCENARIO_CHARGEBACK_QUEUE), handler: scenarioChargebackHandler(scenario) },
    { queue: queueSpec(SCENARIO_POLL_QUEUE), handler: scenarioPollHandler(scenario) },
    { queue: queueSpec(SCENARIO_DECIDE_QUEUE), handler: scenarioDecideHandler(scenario) },
    // The events capture sync emits: M3-01 derives (or releases) the payment's hold from the mirror.
    { queue: queueSpec("payment.captured"), handler: holds },
    { queue: queueSpec("payment.status_changed"), handler: holds },
    // The events dispute sync emits (M2-06): M3-01 links the dispute-held payment's hold, M3-08 writes the
    // seller's `dispute_opened` notification, then M2-07 drafts (one entry per queue; all idempotent and
    // in the delivery's transaction).
    {
      queue: queueSpec("dispute.opened"),
      handler: inOrder(holds, disputeOpenedHandler(notifications), draft),
    },
    { queue: queueSpec("dispute.status_changed"), handler: draft },
    // The action events (M2-08); M2-09 / M3-08 consume them for real. `action.proposed` too, or its
    // outbox rows stay unpublished and the relay re-sends them every minute (BL-01 6568052054).
    { queue: queueSpec("action.proposed"), handler: recordEvent },
    { queue: queueSpec("action.approved"), handler: recordEvent },
    { queue: queueSpec("action.executed"), handler: recordEvent },
    { queue: queueSpec("action.failed"), handler: recordEvent },
    { queue: queueSpec("action.unknown"), handler: recordEvent },
    // M3-01's hold events. M3-08: `hold.opened` writes the `hold_opened` notification (and its email job),
    // then M3-02 explains the hold (one entry per queue; both idempotent, in the delivery's transaction).
    { queue: queueSpec("hold.opened"), handler: inOrder(holdOpenedHandler(notifications), explain) },
    { queue: queueSpec("hold.released"), handler: recordEvent },
    // M3-02: the EN/HI toggle asks for a locale without an explanation; `hold.explained` is recorded.
    { queue: queueSpec("hold.explain_requested"), handler: explain },
    { queue: queueSpec("hold.explained"), handler: recordEvent },
    // M3-04: the seller confirmed the guided Completed step (M3-08 can compose the 7-day reminder here).
    { queue: queueSpec("hold.completed_confirmed"), handler: recordEvent },
    // M3-08: every new notification row enqueues one `notification.send_email` job.
    {
      queue: queueSpec(NOTIFICATION_SEND_EMAIL_QUEUE),
      handler: sendEmailHandler({ db: rt.db, email, now: () => new Date() }),
    },
  ];
}

/** Runs handlers one after another in the same delivery (one registry entry per queue). */
export function inOrder(...handlers: readonly Handler[]): Handler {
  return async (data, ctx) => {
    for (const h of handlers) await h(data, ctx);
  };
}

/** Logs the event; the receipt and `published_at` are written by `consume()`. */
export const recordEvent: Handler = (_data, { envelope, log }) => {
  log.info({ messageId: envelope.messageId }, "domain event recorded");
  return Promise.resolve();
};
