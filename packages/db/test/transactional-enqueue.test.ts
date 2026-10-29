// The core architecture rule (ADR 0004): a state change and its job are written in one transaction.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "../src/client.ts";
import { createQueue, jobDb, type Queue } from "../src/queue.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

class Rollback extends Error {}

describe.skipIf(!dbAvailable)("transactional enqueue (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  const queueName = `m0-03-tx-${randomUUID()}`;
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

  it("the job exists after COMMIT", async () => {
    const id = await db.transaction(async (tx) => boss.send(queueName, { case: "commit" }, { db: jobDb(tx) }));
    expect(id).toEqual(expect.any(String));
    const jobs = await boss.findJobs(queueName, { id: id ?? "" });
    expect(jobs.map((j) => j.data)).toEqual([{ case: "commit" }]);
  });

  it("the job does not exist after ROLLBACK", async () => {
    const sent: { id?: string | null } = {};
    await expect(
      db.transaction(async (tx) => {
        sent.id = await boss.send(queueName, { case: "rollback" }, { db: jobDb(tx) });
        throw new Rollback("roll back the state change and its job");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(sent.id).toEqual(expect.any(String));
    expect(await boss.findJobs(queueName, { id: sent.id ?? "" })).toEqual([]);
    expect(await boss.findJobs(queueName, { data: { case: "rollback" } })).toEqual([]);
  });
});
