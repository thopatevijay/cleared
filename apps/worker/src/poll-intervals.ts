// How often each kind of consumer polls Postgres when idle (M5-PERF, BL-01 6629874892). Before, every
// queue and every `.dlq` ran 5 pollers at pg-boss's 2 s default: ~60 queues × 5 / 2 s ≈ 150 fetches a
// second on a 0.1-CPU database with nothing to do. Now new jobs wake their consumers by LISTEN/NOTIFY
// (the queue's `notify` flag, `useListenNotify` on the worker's pg-boss), so the poll is only a backstop.
import { SCENARIO_POLL_QUEUE } from "@cleared/db";

/** The fallback poll while the LISTEN connection is down (pg-boss's default; tests pass 0.5, its minimum). */
export const POLLING_INTERVAL_SECONDS = 2;

/**
 * The idle poll while LISTEN/NOTIFY is up. A NOTIFY wakes the consumers as soon as a runnable job commits;
 * this poll only picks up delayed jobs (`startAfter`, retry backoff) once due, or a notification lost
 * while the listener reconnected (pg-boss also forces one fetch on reconnect).
 */
export const NOTIFY_POLLING_INTERVAL_SECONDS = 30;

/**
 * Queues whose delayed jobs carry the user-visible cadence: `scenario.poll` schedules itself 30 s–2 min
 * ahead, so its backstop is short enough that the judge timeline doesn't drift by a full backstop.
 */
export const NOTIFY_POLLING_OVERRIDES: Readonly<Record<string, number>> = {
  [SCENARIO_POLL_QUEUE]: 10,
};

/** Dead-letter consumers only log and raise one Sentry event: one slot, polled once a minute. */
export const DLQ_POLLING_INTERVAL_SECONDS = 60;
export const DLQ_CONCURRENCY = 1;

/**
 * Cron queues (outbox relay, deadline watcher, reconcile, synthetic, retention purge) get one job per
 * minute at most, so a tick may start up to 30 s late; their work is minute-granular.
 */
export const CRON_POLLING_INTERVAL_SECONDS = 30;

export interface PollDeps {
  /** Tests: one fixed interval for every consumer (fast and deterministic). */
  readonly pollingIntervalSeconds?: number;
}

/** The backstop poll for `queue` while LISTEN/NOTIFY is up. */
export function notifyPollingSeconds(deps: PollDeps, queue: string): number {
  return deps.pollingIntervalSeconds ?? NOTIFY_POLLING_OVERRIDES[queue] ?? NOTIFY_POLLING_INTERVAL_SECONDS;
}

/** `work()` options for a cron queue's single consumer. */
export function cronWorkOptions(deps: PollDeps): { readonly pollingIntervalSeconds: number } {
  return { pollingIntervalSeconds: deps.pollingIntervalSeconds ?? CRON_POLLING_INTERVAL_SECONDS };
}
