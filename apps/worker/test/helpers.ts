// Worker test helpers: the compose Postgres (skip when unreachable), a capturing pino logger, a polling
// wait, and a harness that wires a registry onto a real pg-boss with fast polling.
import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@cleared/adapters";
import { closeDb, createDb, createQueue, databaseUrl, type Db, type Queue } from "@cleared/db";
import { wireRegistry } from "../src/boss.ts";
import { dlqName } from "../src/queues.ts";
import type { Registry } from "../src/registry.ts";

export const url = databaseUrl();

async function reachable(): Promise<boolean> {
  const db = createDb(url);
  try {
    await db.$client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await closeDb(db).catch(() => undefined);
  }
}

export const dbAvailable = await reachable();
// REQUIRE_DB=1 (set in CI) turns the skip into a failure (BL-01).
if (!dbAvailable && process.env["REQUIRE_DB"] === "1") {
  throw new Error("worker integration tests: no Postgres at DATABASE_URL and REQUIRE_DB=1: cannot skip");
}
if (!dbAvailable) console.warn("worker integration tests skipped: no Postgres at DATABASE_URL (run make up)");

export type LogLine = Record<string, unknown> & { msg?: string };

export function captureLog(service = "worker"): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = createLogger({
    service,
    destination: {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as LogLine);
      },
    },
  });
  return { log, lines };
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const testQueue = (label: string): string => `test.m1-03.${label}.${randomUUID().slice(0, 8)}`;

export interface Harness {
  readonly db: Db;
  readonly boss: Queue;
  readonly log: Logger;
  readonly lines: LogLine[];
  close(): Promise<void>;
}

/** A real pg-boss with `registry` wired (0.5 s polling); `close` deletes the test queues. */
export async function harness(registry: Registry): Promise<Harness> {
  const db = createDb(url);
  const boss = await createQueue(db);
  const { log, lines } = captureLog();
  await wireRegistry({ db, boss, log, now: () => new Date(), pollingIntervalSeconds: 0.5 }, registry);
  return {
    db,
    boss,
    log,
    lines,
    async close() {
      await boss.stop({ graceful: true, timeout: 5_000 });
      const cleanup = await createQueue(db);
      for (const { queue } of registry) {
        await cleanup.deleteQueue(queue.name);
        await cleanup.deleteQueue(dlqName(queue.name));
      }
      await cleanup.stop({ graceful: false });
      await closeDb(db);
    },
  };
}
