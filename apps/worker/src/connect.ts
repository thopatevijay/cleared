// The real `Connect`: one Drizzle pool (max 10) plus pg-boss with its own pool (max 4), M0-03; then the
// registry's queues and consumers and the outbox relay (M1-03).
import type { Logger } from "@cleared/adapters";
import { closeDb, createDb, createQueue } from "@cleared/db";
import { wireWorker } from "./boss.ts";
import type { Connect } from "./main.ts";
import { defaultRegistry, type Registry } from "./registry.ts";

/** How long a graceful pg-boss stop may wait for active jobs; Render allows 30 s after SIGTERM. */
export const STOP_TIMEOUT_MS = 20_000;

export interface ConnectOptions {
  readonly log: Logger;
  readonly registry?: Registry;
  readonly pollingIntervalSeconds?: number;
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
            ...(opts.pollingIntervalSeconds === undefined
              ? {}
              : { pollingIntervalSeconds: opts.pollingIntervalSeconds }),
          },
          opts.registry ?? defaultRegistry(),
        );
      } catch (error) {
        await boss.stop({ graceful: false }).catch(() => undefined);
        throw error;
      }
      return {
        async stop() {
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
