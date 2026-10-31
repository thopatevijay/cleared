// The one place consumers are registered (M1-03). Each entry is a queue (created with its `.dlq`) and
// its idempotent handler; `boss.ts` wires every entry with the same concurrency, retry and DLQ policy.
// Queue specs come from @cleared/db (`KNOWN_QUEUES`), which `migrate` also creates (M1-04).
// M2 and M3 add theirs here.
import { correlationIdOrNew } from "@cleared/adapters";
import {
  ACTION_EXECUTE_QUEUE,
  ACTION_RECONCILE_QUEUE,
  createPublisher,
  PAYPAL_CAPTURE_SYNC_QUEUE,
  PAYPAL_DISPUTE_SYNC_QUEUE,
  queueSpec,
  SANDBOX_TEST_PAYMENT_QUEUE,
  SCENARIO_CAPTURE_QUEUE,
  SCENARIO_CHARGEBACK_QUEUE,
  SCENARIO_DECIDE_QUEUE,
  SCENARIO_POLL_QUEUE,
  SCENARIO_SEED_PACK_QUEUE,
  type Db,
  type Queue,
} from "@cleared/db";
import type { AiRuntime } from "./ai.ts";
import type { Handler } from "./consume.ts";
import { captureSyncHandler } from "./jobs/capture-sync.ts";
import { killSwitchFromEnv } from "./jobs/action-runtime.ts";
import { disputeSyncHandler } from "./jobs/dispute-sync.ts";
import { draftDisputeHandler } from "./jobs/draft-dispute.ts";
import { executeActionHandler } from "./jobs/execute-action.ts";
import { reconcileActionHandler } from "./jobs/reconcile-action.ts";
import { checkScopeHandler } from "./jobs/check-scope.ts";
import { extractEvidenceHandler } from "./jobs/extract-evidence.ts";
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
export function defaultRegistry(rt: Runtime, paypal: PayPalClients, ai: AiRuntime): Registry {
  const publisher = createPublisher(rt.db, rt.boss, correlationIdOrNew);
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
        now: () => new Date(),
      }),
    },
    {
      queue: queueSpec(SANDBOX_TEST_PAYMENT_QUEUE),
      handler: testPaymentHandler({ db: rt.db, orders: paypal.orders }),
    },
    // M2-03: extract facts from each new evidence item; M2-04: check the pack's scope once every item is extracted.
    {
      queue: queueSpec("evidence.added"),
      handler: extractEvidenceHandler({ db: rt.db, publisher, ...ai, now: () => new Date() }),
    },
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
    // The events capture sync emits. Consuming them marks the outbox row published (so the relay does
    // not re-send it); M3-01 replaces these with hold derivation.
    { queue: queueSpec("payment.captured"), handler: recordEvent },
    { queue: queueSpec("payment.status_changed"), handler: recordEvent },
    // The events dispute sync emits (M2-06); M2-07 drafts on them (M3 may add more consumers).
    { queue: queueSpec("dispute.opened"), handler: draft },
    { queue: queueSpec("dispute.status_changed"), handler: draft },
    // The action events (M2-08); M2-09 / M3-08 consume them for real.
    { queue: queueSpec("action.approved"), handler: recordEvent },
    { queue: queueSpec("action.executed"), handler: recordEvent },
    { queue: queueSpec("action.failed"), handler: recordEvent },
    { queue: queueSpec("action.unknown"), handler: recordEvent },
  ];
}

/** Logs the event; the receipt and `published_at` are written by `consume()`. */
export const recordEvent: Handler = (_data, { envelope, log }) => {
  log.info({ messageId: envelope.messageId }, "domain event recorded");
  return Promise.resolve();
};
