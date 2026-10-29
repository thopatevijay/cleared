import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { createQueue, QUEUE_SCHEMA, type Queue } from "../src/queue.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

describe.skipIf(!dbAvailable)("pg-boss round-trip (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  const queueName = `m0-03-roundtrip-${randomUUID()}`;
  let boss: Queue;

  beforeAll(async () => {
    boss = await createQueue(db);
    await boss.createQueue(queueName);
  });

  afterAll(async () => {
    await boss.deleteQueue(queueName);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("creates its own schema", async () => {
    const { rowCount } = await db.$client.query(
      "select 1 from information_schema.schemata where schema_name = $1",
      [QUEUE_SCHEMA],
    );
    expect(rowCount).toBe(1);
  });

  it("send -> work -> completed", async () => {
    const handled = new Promise<{ id: string; data: unknown }>((resolve) => {
      void boss.work<{ n: number }>(queueName, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
        if (job) resolve({ id: job.id, data: job.data });
        return Promise.resolve({ ok: true });
      });
    });
    const id = await boss.send(queueName, { n: 42 });
    const seen = await handled;
    expect(seen).toEqual({ id, data: { n: 42 } });

    let state: string | undefined;
    for (let i = 0; i < 40 && state !== "completed"; i++) {
      state = (await boss.findJobs(queueName, { id: id ?? "" }))[0]?.state;
      if (state !== "completed") await new Promise((r) => setTimeout(r, 100));
    }
    expect(state).toBe("completed");
  });
});
