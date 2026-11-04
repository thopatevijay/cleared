// M5-PERF: a registry queue's consumer polls only every 30 s while idle, so a new job must reach it by
// LISTEN/NOTIFY. Proves the wake path end to end on the compose Postgres: every known queue carries the
// `notify` flag after `ensureKnownQueues` (what `migrate` runs; its `.dlq` doesn't), and a job sent from
// another pg-boss instance (the web's send-only producer) is consumed well inside the 30 s backstop.
import { closeDb, createDb, createQueue, ensureKnownQueues, KNOWN_QUEUES, type Queue } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workOptions } from "../src/boss.ts";
import { NOTIFY_POLLING_INTERVAL_SECONDS } from "../src/poll-intervals.ts";
import { dlqName, ensureQueue } from "../src/queues.ts";
import { dbAvailable, testQueue, until, url } from "./helpers.ts";

const db = createDb(url);
const name = testQueue("notify");
let producer: Queue;
let consumer: Queue | undefined;

describe.skipIf(!dbAvailable)("LISTEN/NOTIFY wake-up (M5-PERF)", () => {
  beforeAll(async () => {
    producer = await createQueue(db, { background: false, max: 2 });
    // created before the consumer starts, so its queue cache already holds `notify: true`
    await ensureQueue(producer, { name, expireInSeconds: 60 });
  });
  afterAll(async () => {
    await consumer?.stop({ graceful: false, close: true });
    for (const q of [name, dlqName(name)]) await producer.deleteQueue(q).catch(() => undefined);
    await producer.stop({ graceful: false, close: true });
    await closeDb(db);
  });

  it("flags every known queue for NOTIFY, and no dead-letter queue", async () => {
    // what `migrate` runs (other files' harnesses delete the registry queues they wired)
    await ensureKnownQueues(producer);
    const r = await db.$client.query<{ name: string; notify: boolean }>(
      "select name, notify from pgboss.queue where name = any($1)",
      [KNOWN_QUEUES.flatMap((q) => [q.name, dlqName(q.name)])],
    );
    const flags = new Map(r.rows.map((row) => [row.name, row.notify]));
    for (const q of KNOWN_QUEUES) {
      expect(flags.get(q.name), q.name).toBe(true);
      expect(flags.get(dlqName(q.name)), dlqName(q.name)).toBe(false);
    }
  });

  it("wakes an idle consumer (30 s backstop) within seconds of a send", async () => {
    consumer = await createQueue(db);
    // the fallback poll raised to the backstop too, so only a NOTIFY can deliver inside 30 s
    const opts = { ...workOptions({}, name), pollingIntervalSeconds: NOTIFY_POLLING_INTERVAL_SECONDS };
    expect(opts.notifyPollingIntervalSeconds).toBe(NOTIFY_POLLING_INTERVAL_SECONDS);
    const seen: number[] = [];
    await consumer.work(name, opts, (jobs) => {
      seen.push(Date.now() - (jobs[0]?.data as { sentAt: number }).sentAt);
      return Promise.resolve();
    });
    // let every slot finish its first (empty) fetch and fall into the 30 s backstop sleep
    await new Promise((r) => setTimeout(r, 1_500));
    for (let i = 0; i < 3; i++) {
      await producer.send(name, { sentAt: Date.now() });
      await until(() => seen.length === i + 1, 10_000);
    }
    expect(Math.max(...seen)).toBeLessThan(5_000);
  });
});
