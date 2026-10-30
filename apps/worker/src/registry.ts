// The one place consumers are registered (M1-03). Each entry is a queue (created with its `.dlq`) and
// its idempotent handler; `boss.ts` wires every entry with the same concurrency, retry and DLQ policy.
// Queue specs come from @cleared/db (`KNOWN_QUEUES`), which `migrate` also creates (M1-04).
// M2 and M3 add theirs here.
import { correlationIdOrNew } from "@cleared/adapters";
import {
  createPublisher,
  PAYPAL_CAPTURE_SYNC_QUEUE,
  queueSpec,
  SANDBOX_TEST_PAYMENT_QUEUE,
  type Db,
  type Queue,
} from "@cleared/db";
import type { Handler } from "./consume.ts";
import { captureSyncHandler } from "./jobs/capture-sync.ts";
import { testPaymentHandler } from "./jobs/test-payment.ts";
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
export function defaultRegistry(rt: Runtime, paypal: PayPalClients): Registry {
  const publisher = createPublisher(rt.db, rt.boss, correlationIdOrNew);
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
      queue: queueSpec(SANDBOX_TEST_PAYMENT_QUEUE),
      handler: testPaymentHandler({ db: rt.db, orders: paypal.orders }),
    },
    // The events capture sync emits. Consuming them marks the outbox row published (so the relay does
    // not re-send it); M3-01 replaces these with hold derivation.
    { queue: queueSpec("payment.captured"), handler: recordEvent },
    { queue: queueSpec("payment.status_changed"), handler: recordEvent },
  ];
}

/** Logs the event; the receipt and `published_at` are written by `consume()`. */
export const recordEvent: Handler = (_data, { envelope, log }) => {
  log.info({ messageId: envelope.messageId }, "domain event recorded");
  return Promise.resolve();
};
