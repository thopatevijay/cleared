// AC Idempotency: the same messageId delivered twice runs the handler's effect once; the second
// delivery acks `{ skipped: "duplicate" }`. Also: a throwing handler leaves no receipt, and the first
// consumption of an emitted event sets its outbox row's `published_at`.
import { randomUUID } from "node:crypto";
import { DomainEventSchema } from "@cleared/core";
import { createPublisher, platform, sendEnvelope, withTransaction } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handler } from "../src/consume.ts";
import { dbAvailable, harness, testQueue, until, type Harness } from "./helpers.ts";

/** An emitted event's queue is its type. */
const EVENT_QUEUE = "hold.opened";

describe.skipIf(!dbAvailable)("consume() (compose Postgres)", () => {
  const dupQueue = testQueue("dup");
  const flakyQueue = testQueue("flaky");
  const effects: unknown[] = [];
  let flakyCalls = 0;
  let h: Harness;

  const record: Handler = (data) => {
    effects.push(data);
    return Promise.resolve();
  };
  // Fails its first attempt after writing its receipt; the retry must not see a duplicate.
  const flaky: Handler = () => {
    flakyCalls += 1;
    return flakyCalls === 1 ? Promise.reject(new Error("first attempt fails")) : Promise.resolve();
  };

  beforeAll(async () => {
    h = await harness([
      { queue: { name: dupQueue, expireInSeconds: 30 }, handler: record },
      { queue: { name: flakyQueue, expireInSeconds: 30, retryDelay: 1 }, handler: flaky },
      { queue: { name: EVENT_QUEUE, expireInSeconds: 30 }, handler: record },
    ]);
  });
  afterAll(async () => {
    await h.close();
  });

  const state = async (queue: string, id: string) => (await h.boss.findJobs(queue, { id }))[0];

  it("runs the effect once for two deliveries of one messageId; the second acks skipped: duplicate", async () => {
    const envelope = { messageId: randomUUID(), correlationId: "corr-dup", data: { n: 1 } };
    const [first, second] = await withTransaction(h.db, async (tx) => [
      await sendEnvelope(h.boss, tx, dupQueue, envelope),
      await sendEnvelope(h.boss, tx, dupQueue, envelope),
    ]);
    const ids = [first ?? "", second ?? ""];
    await until(async () => {
      const jobs = await Promise.all(ids.map((id) => state(dupQueue, id)));
      return jobs.every((j) => j?.state === "completed");
    });

    expect(effects).toEqual([{ n: 1 }]);
    const outputs = await Promise.all(ids.map(async (id) => (await state(dupQueue, id))?.output));
    expect(outputs).toEqual(expect.arrayContaining([{ consumed: true }, { skipped: "duplicate" }]));
    const skipped = h.lines.filter((l) => l.msg === "message skipped: duplicate");
    expect(skipped).toEqual([expect.objectContaining({ queue: dupQueue, messageId: envelope.messageId })]);
  });

  it("a throwing handler rolls back its receipt, so the retry runs the handler again", async () => {
    const envelope = { messageId: randomUUID(), correlationId: "corr-flaky", data: {} };
    const id = await withTransaction(h.db, (tx) => sendEnvelope(h.boss, tx, flakyQueue, envelope));
    await until(async () => (await state(flakyQueue, id ?? ""))?.state === "completed");
    expect(flakyCalls).toBe(2);
    expect((await state(flakyQueue, id ?? ""))?.output).toEqual({ consumed: true });
    expect(await platform(h.db).consumerReceipts.record(flakyQueue, envelope.messageId)).toBe(false);
  });

  it("sets the outbox row's published_at on first consumption of an emitted event", async () => {
    const ws = await platform(h.db).workspaces.create({
      kind: "demo",
      locale: "en",
      timezone: "UTC",
      baseCurrency: "USD",
    });
    const publisher = createPublisher(h.db, h.boss, () => "corr-emit");
    const event = DomainEventSchema.parse({
      type: EVENT_QUEUE,
      version: 1,
      workspaceId: ws.id,
      occurredAt: new Date().toISOString(),
      data: { holdId: randomUUID(), captureId: "3C679366HH908993F", reason: "PAYMENT_REVIEW" },
    });
    const row = await withTransaction(h.db, (tx) => publisher.emit(tx, event));
    await until(async () => (await state(EVENT_QUEUE, row.id))?.state === "completed");

    const [stored] = await h.db.$client
      .query<{ published_at: Date | null }>("select published_at from outbox where id = $1", [row.id])
      .then((r) => r.rows);
    expect(stored?.published_at).toBeInstanceOf(Date);
    expect(effects).toContainEqual(event);
  });
});
