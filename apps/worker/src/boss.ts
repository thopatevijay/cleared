// Wires the registry onto pg-boss (M1-03): creates each queue and its `.dlq`, starts its consumer with
// concurrency 5 (architecture §12), starts a dead-letter consumer that logs and records the message,
// and schedules the outbox relay every minute, the dispute deadline watcher every 15 (M2-06), and the
// reconcile poll every 15 plus the daily synthetic judge path (M3-09), and the daily retention purge (M4-07).
import { correlationIdOrNew, reportError } from "@cleared/adapters";
import { createPublisher, RELAY_CRON, RELAY_QUEUE, relayOutbox, type Db, type Queue } from "@cleared/db";
import { consume, type ConsumeDeps, type Handler } from "./consume.ts";
import { dlqName, ensureQueue } from "./queues.ts";
import { scheduleDeadlineWatch } from "./jobs/deadline-watcher.ts";
import { scheduleReconcile } from "./jobs/reconcile.ts";
import { scheduleRetentionPurge } from "./jobs/retention-purge.ts";
import { scheduleSynthetic } from "./jobs/synthetic-judge-path.ts";
import type { Registry } from "./registry.ts";

/** Jobs in flight per queue per worker process (architecture §12). */
export const CONCURRENCY = 5;
/** pg-boss's default idle poll; tests pass 0.5 (its minimum). */
export const POLLING_INTERVAL_SECONDS = 2;

export interface WireDeps extends ConsumeDeps {
  readonly db: Db;
  readonly boss: Queue;
  readonly pollingIntervalSeconds?: number;
  /** M3-09: false skips the reconcile, synthetic and retention schedules (`OPS_SCHEDULES=off`: local stubbed E2E) */
  readonly opsSchedules?: boolean;
}

function workOptions(deps: WireDeps) {
  return {
    localConcurrency: CONCURRENCY,
    batchSize: 1,
    includeMetadata: true,
    pollingIntervalSeconds: deps.pollingIntervalSeconds ?? POLLING_INTERVAL_SECONDS,
  } as const;
}

/** Dead-letter handler: the message exhausted its retries. Logs it and raises one Sentry event (M1-08). */
export function deadLetterHandler(queue: string): Handler {
  return (_data, { envelope, log, job }) => {
    const fields = { queue, dlq: dlqName(queue), messageId: envelope.messageId, sourceId: job.sourceId };
    log.error(fields, "message dead-lettered");
    reportError(new Error(`message dead-lettered: ${queue}`), { extra: fields });
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
  await deps.boss.work(
    RELAY_QUEUE,
    { pollingIntervalSeconds: workOptions(deps).pollingIntervalSeconds },
    async () => {
      const result = await relayOutbox({ ...deps, correlation: correlationIdOrNew });
      if (result.stale > 0) deps.log.warn(result, "outbox relay re-sent unpublished rows");
    },
  );
}

export async function wireWorker(deps: WireDeps, registry: Registry): Promise<void> {
  await wireRegistry(deps, registry);
  await scheduleRelay(deps);
  const publisher = createPublisher(deps.db, deps.boss, correlationIdOrNew);
  // M3-08: the watcher's alerts enqueue their email jobs through the outbox publisher
  await scheduleDeadlineWatch({ ...deps, publisher });
  // M3-09: the 15-minute reconcile poll + SLO checks, and the daily synthetic judge path
  if (deps.opsSchedules === false) return;
  await scheduleReconcile({ ...deps, publisher });
  await scheduleSynthetic({ ...deps, publisher });
  // M4-07: the daily demo retention purge (ADR 0020)
  await scheduleRetentionPurge(deps);
}
