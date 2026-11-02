// The real `Connect`: one Drizzle pool (max 10) plus pg-boss with its own pool (max 4), M0-03; then the
// registry's queues and consumers and the outbox relay (M1-03).
import type { Logger } from "@cleared/adapters";
import { closeDb, createDb, createQueue } from "@cleared/db";
import { wireWorker } from "./boss.ts";
import { startHeartbeat } from "./heartbeat.ts";
import type { Connect } from "./main.ts";
import type { Registry, Runtime } from "./registry.ts";

/** How long a graceful pg-boss stop may wait for active jobs; Render allows 30 s after SIGTERM. */
export const STOP_TIMEOUT_MS = 20_000;

export interface ConnectOptions {
  readonly log: Logger;
  /** A fixed registry, or one built once the pool and pg-boss exist (production: `defaultRegistry`). */
  readonly registry: Registry | ((rt: Runtime) => Registry);
  readonly pollingIntervalSeconds?: number;
  /** M3-09: false skips the reconcile + synthetic schedules (`OPS_SCHEDULES=off`). */
  readonly opsSchedules?: boolean;
  /** Heartbeat interval (default 30 s, M1-08). */
  readonly heartbeatIntervalMs?: number;
}

export function makeConnect(opts: ConnectOptions): Connect {
  return async (url) => {
    const db = createDb(url);
    try {
      await db.$client.query("select 1");
      const boss = await createQueue(db);
      try {
        await wireWorker(
          {
            db,
            boss,
            log: opts.log,
            now: () => new Date(),
            ...(opts.opsSchedules === undefined ? {} : { opsSchedules: opts.opsSchedules }),
            ...(opts.pollingIntervalSeconds === undefined
              ? {}
              : { pollingIntervalSeconds: opts.pollingIntervalSeconds }),
          },
          typeof opts.registry === "function" ? opts.registry({ db, boss }) : opts.registry,
        );
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
      const heartbeat = startHeartbeat({
        db,
        log: opts.log,
        ...(opts.heartbeatIntervalMs === undefined ? {} : { intervalMs: opts.heartbeatIntervalMs }),
      });
      await heartbeat.first;
      return {
        async stop() {
          heartbeat.stop();
          try {
            await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
          } finally {
            await closeDb(db);
          }
        },
      };
    } catch (error) {
      await closeDb(db).catch(() => undefined);
      throw error;
    }
  };
}
