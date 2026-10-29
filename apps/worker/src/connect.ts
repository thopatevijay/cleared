// The real `Connect`: one Drizzle pool (max 10) plus pg-boss with its own pool (max 4), M0-03.
import { closeDb, createDb, createQueue } from "@cleared/db";
import type { Resources } from "./main.ts";

/** How long a graceful pg-boss stop may wait for active jobs; Render allows 30 s after SIGTERM. */
export const STOP_TIMEOUT_MS = 20_000;

export async function connect(url: string): Promise<Resources> {
  const db = createDb(url);
  try {
    await db.$client.query("select 1");
    const boss = await createQueue(db);
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
}
