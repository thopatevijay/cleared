// Wires the registry onto pg-boss (M1-03): creates each queue and its `.dlq`, starts its consumer with
// concurrency 5 (architecture §12), starts a dead-letter consumer that logs and records the message,
// and schedules the outbox relay every minute.
import { correlationIdOrNew } from "@cleared/adapters";
import { RELAY_CRON, RELAY_QUEUE, relayOutbox, type Db, type Queue } from "@cleared/db";
import { consume, type ConsumeDeps, type Handler } from "./consume.ts";
import { dlqName, ensureQueue } from "./queues.ts";
import type { Registry } from "./registry.ts";

/** Jobs in flight per queue per worker process (architecture §12). */
export const CONCURRENCY = 5;
/** pg-boss's default idle poll; tests pass 0.5 (its minimum). */
export const POLLING_INTERVAL_SECONDS = 2;

export interface WireDeps extends ConsumeDeps {
  readonly db: Db;
  readonly boss: Queue;
  readonly pollingIntervalSeconds?: number;
}

function workOptions(deps: WireDeps) {
  return {
    localConcurrency: CONCURRENCY,
    batchSize: 1,
    includeMetadata: true,
    pollingIntervalSeconds: deps.pollingIntervalSeconds ?? POLLING_INTERVAL_SECONDS,
  } as const;
}

/** Dead-letter handler: the message exhausted its retries. M1-08 adds the Sentry alert. */
export function deadLetterHandler(queue: string): Handler {
  return (_data, { envelope, log, job }) => {
    log.error({ queue, dlq: dlqName(queue), messageId: envelope.messageId, sourceId: job.sourceId }, "message dead-lettered");
    return Promise.resolve();
  };
}

export async function wireRegistry(deps: WireDeps, registry: Registry): Promise<void> {
  const opts = workOptions(deps);
  for (const { queue, handler } of registry) {
    await ensureQueue(deps.boss, queue);
    await deps.boss.work(queue.name, opts, consume(deps, queue.name, handler));
    const dlq = dlqName(queue.name);
    await deps.boss.work(dlq, opts, consume(deps, dlq, deadLetterHandler(queue.name)));
  }
}

/** Every minute: re-send the jobs of outbox rows still unpublished after 2 minutes. */
export async function scheduleRelay(deps: WireDeps): Promise<void> {
  if (!(await deps.boss.getQueue(RELAY_QUEUE))) {
    await deps.boss.createQueue(RELAY_QUEUE, { policy: "singleton", expireInSeconds: 60, retryLimit: 0 });
  }
  await deps.boss.schedule(RELAY_QUEUE, RELAY_CRON);
  await deps.boss.work(RELAY_QUEUE, { pollingIntervalSeconds: workOptions(deps).pollingIntervalSeconds }, async () => {
    const result = await relayOutbox({ ...deps, correlation: correlationIdOrNew });
    if (result.stale > 0) deps.log.warn(result, "outbox relay re-sent unpublished rows");
  });
}

export async function wireWorker(deps: WireDeps, registry: Registry): Promise<void> {
  await wireRegistry(deps, registry);
  await scheduleRelay(deps);
}

