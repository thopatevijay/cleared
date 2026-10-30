// AC Backoff/DLQ: a handler that always throws, with a test retry limit of 2, lands in `<queue>.dlq`
// after 3 attempts, with increasing delays between attempts. pg-boss 12 keeps no separate history
// table, so the test reads each attempt's job row as pg-boss hands it over (`retryCount`, `startedOn`,
// and `startAfter`, the time pg-boss scheduled that retry for) and the dead-letter job's source fields.
import { randomUUID } from "node:crypto";
import { sendEnvelope, withTransaction, type JobWithMetadata } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handler } from "../src/consume.ts";
import { dlqName } from "../src/queues.ts";
import { dbAvailable, harness, testQueue, until, type Harness } from "./helpers.ts";

describe.skipIf(!dbAvailable)("retry with backoff, then dead-letter (compose Postgres)", () => {
  const queue = testQueue("dlq");
  const attempts: JobWithMetadata<unknown>[] = [];
  let h: Harness;

  const alwaysThrows: Handler = (_data, { job }) => {
    attempts.push(job);
    return Promise.reject(new Error(`attempt ${String(job.retryCount + 1)} fails`));
  };

  beforeAll(async () => {
    h = await harness([{ queue: { name: queue, expireInSeconds: 30, retryLimit: 2, retryDelay: 1 }, handler: alwaysThrows }]);
  });
  afterAll(async () => {
    await h.close();
  });

  it("makes 3 attempts with growing delays, then moves the message to <queue>.dlq", async () => {
    const envelope = { messageId: randomUUID(), correlationId: "corr-dlq", data: { case: "always throws" } };
    const id = (await withTransaction(h.db, (tx) => sendEnvelope(h.boss, tx, queue, envelope))) ?? "";

    const dlq = dlqName(queue);
    await until(async () => (await h.boss.findJobs(dlq, { data: envelope })).some((j) => j.state === "completed"));

    // Three attempts of the one job, retryCount 0, 1, 2.
    expect(attempts.map((a) => [a.id, a.retryCount])).toEqual([
      [id, 0],
      [id, 1],
      [id, 2],
    ]);
    // Delay before attempt n+1 = the retry's scheduled start minus attempt n's start (handler runs ~ms).
    const delays = [1, 2].map((n) => {
      const prev = attempts[n - 1];
      const next = attempts[n];
      if (!prev || !next) throw new Error("missing attempt");
      return next.startAfter.getTime() - prev.startedOn.getTime();
    });
    // retryDelay 1 s with backoff and jitter: about 1–2 s, then about 2–4 s.
    expect(delays[0]).toBeGreaterThanOrEqual(900);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? Infinity);

    const [original] = await h.boss.findJobs(queue, { id });
    expect(original).toMatchObject({ state: "failed", retryCount: 2, retryLimit: 2, deadLetter: dlq });

    const [dead] = await h.boss.findJobs(dlq, { data: envelope });
    expect(dead).toMatchObject({ sourceName: queue, sourceId: id, sourceRetryCount: 2, data: envelope });
    expect(dead?.output).toEqual({ consumed: true });
    expect(h.lines).toContainEqual(
      expect.objectContaining({ msg: "message dead-lettered", queue, messageId: envelope.messageId, correlationId: "corr-dlq" }),
    );
    console.log(`backoff delays (ms): ${delays.join(", ")}`);
  });
});
