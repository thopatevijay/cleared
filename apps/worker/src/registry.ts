// The one place consumers are registered (M1-03). Each entry is a queue (created with its `.dlq`) and
// its idempotent handler; `boss.ts` wires every entry with the same concurrency, retry and DLQ policy.
// M1-04 adds `paypal.capture.sync`; M2 and M3 add theirs here.
import type { Handler } from "./consume.ts";
import type { QueueSpec } from "./queues.ts";

export interface Registration {
  readonly queue: QueueSpec;
  readonly handler: Handler;
}

export type Registry = readonly Registration[];

/** The production registry. The outbox relay is not listed: `boss.ts` schedules it on every worker. */
export function defaultRegistry(): Registry {
  return [];
}
