// M1-03 outbox: `emit` writes the outbox row and its pg-boss job in the caller's transaction, and the
// relay re-sends a lost job exactly once (injected clock). Runs on the compose Postgres.
import { randomUUID } from "node:crypto";
import { DomainEventSchema, type DomainEvent } from "@cleared/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outbox } from "../schema/index.ts";
import { closeDb, createDb } from "../src/client.ts";
import { createPublisher, parseEnvelope, relayOutbox, RELAY_AFTER_MS } from "../src/outbox/index.ts";
import { createQueue, type Queue } from "../src/queue.ts";
import { platform } from "../src/repos/platform/index.ts";
import { withTransaction } from "../src/tx.ts";
import { dbAvailable, TEST_DATABASE_URL } from "./db-available.ts";

class Rollback extends Error {}

const TOPIC = "hold.opened";

function holdOpened(workspaceId: string, reason: string): DomainEvent {
  return DomainEventSchema.parse({
    type: TOPIC,
    version: 1,
    workspaceId,
    occurredAt: new Date().toISOString(),
    data: { holdId: randomUUID(), captureId: "3C679366HH908993F", reason },
  });
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!dbAvailable)("outbox (compose Postgres)", () => {
  const db = createDb(TEST_DATABASE_URL);
  let boss: Queue;
  let workspaceId: string;
  /** Other tests and earlier runs leave unpublished rows; the relay counts assert only this test's. */
  const settleOtherRows = async (): Promise<void> => {
    await db.update(outbox).set({ publishedAt: new Date() }).where(sql`${outbox.publishedAt} is null`);
  };

  beforeAll(async () => {
    boss = await createQueue(db);
    await boss.deleteQueue(TOPIC);
    await boss.createQueue(TOPIC);
    const ws = await platform(db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
    });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await boss.deleteQueue(TOPIC);
    await boss.stop({ graceful: false });
    await closeDb(db);
  });

  it("atomicity: emit inside a transaction that throws leaves no outbox row and no job", async () => {
    const publisher = createPublisher(db, boss, () => "corr-atomicity");
    const seen: { id?: string } = {};
    await expect(
      withTransaction(db, async (tx) => {
        seen.id = (await publisher.emit(tx, holdOpened(workspaceId, "atomicity"))).id;
        throw new Rollback("state change failed");
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen.id).toEqual(expect.any(String));
    const id = seen.id ?? "";
    expect(await db.select().from(outbox).where(eq(outbox.id, id))).toEqual([]);
    expect(await boss.findJobs(TOPIC, { id })).toEqual([]);
  });

  it("commit: emit plus commit yields exactly one job, delivered to its handler once", async () => {
    const publisher = createPublisher(db, boss, () => "corr-commit");
    const event = holdOpened(workspaceId, "commit");
    const row = await withTransaction(db, (tx) => publisher.emit(tx, event));

    const jobs = await boss.findJobs(TOPIC, { id: row.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.singletonKey).toBe(row.id);
    expect(parseEnvelope(jobs[0]?.data)).toEqual({
      messageId: row.id,
      correlationId: "corr-commit",
      workspaceId,
      data: event,
    });
    expect(row).toMatchObject({ topic: TOPIC, version: 1, payload: event, publishedAt: null });

    const deliveries: string[] = [];
    await boss.work(TOPIC, { pollingIntervalSeconds: 0.5 }, (batch) => {
      for (const job of batch) deliveries.push(job.id);
      return Promise.resolve();
    });
    await until(async () => (await boss.findJobs(TOPIC, { id: row.id }))[0]?.state === "completed");
    await new Promise((r) => setTimeout(r, 1200)); // two more polls: nothing is delivered again
    await boss.offWork(TOPIC);
    expect(deliveries).toEqual([row.id]);
    expect(await boss.findJobs(TOPIC, { id: row.id })).toHaveLength(1);
  });

  it("relay: an unpublished row older than 2 min is re-enqueued exactly once (injected clock)", async () => {
    await settleOtherRows();
    // A row whose job was lost (written without one, as after manual DB surgery).
    const row = await platform(db).outbox.append({
      topic: TOPIC,
      version: 1,
      payload: holdOpened(workspaceId, "relay"),
    });
    const created = row.createdAt.getTime();
    const relay = (at: number) =>
      relayOutbox({ db, boss, correlation: () => "corr-relay", now: () => new Date(at) });

    expect(await relay(created + RELAY_AFTER_MS - 1_000)).toEqual({ stale: 0, enqueued: 0, failed: [] });
    expect(await boss.findJobs(TOPIC, { id: row.id })).toEqual([]);

    expect(await relay(created + RELAY_AFTER_MS + 1_000)).toEqual({ stale: 1, enqueued: 1, failed: [] });
    // Still unpublished a minute later (nothing consumed it): the existing job is not doubled.
    expect(await relay(created + RELAY_AFTER_MS + 61_000)).toEqual({ stale: 1, enqueued: 0, failed: [] });

    const jobs = await boss.findJobs(TOPIC, { id: row.id });
    expect(jobs).toHaveLength(1);
    expect(parseEnvelope(jobs[0]?.data)).toMatchObject({
      messageId: row.id,
      correlationId: "corr-relay",
      workspaceId,
    });
  });

  it("relay skips published rows", async () => {
    await settleOtherRows();
    const row = await platform(db).outbox.append({
      topic: TOPIC,
      version: 1,
      payload: holdOpened(workspaceId, "published"),
    });
    await platform(db).outbox.markConsumed(row.id, new Date());
    const later = row.createdAt.getTime() + 10 * RELAY_AFTER_MS;
    const result = await relayOutbox({ db, boss, correlation: () => "x", now: () => new Date(later) });
    expect(result.stale).toBe(0);
    expect(await boss.findJobs(TOPIC, { id: row.id })).toEqual([]);
  });
});
