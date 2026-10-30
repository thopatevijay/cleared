// AC Correlation: a correlation ID set before `enqueue` appears in the consumer's log line (pino output
// captured). The worker restores the envelope's correlationId into the AsyncLocalStorage context, and
// the logger's mixin adds it to every line.
import { correlationIdOrNew, withContext } from "@cleared/adapters";
import { createPublisher, withTransaction } from "@cleared/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handler } from "../src/consume.ts";
import { dbAvailable, harness, testQueue, until, type Harness } from "./helpers.ts";

describe.skipIf(!dbAvailable)("correlation id (compose Postgres)", () => {
  const queue = testQueue("corr");
  let h: Harness;

  const handler: Handler = (data, { log }) => {
    log.info({ data }, "handler ran");
    return Promise.resolve();
  };

  beforeAll(async () => {
    h = await harness([{ queue: { name: queue, expireInSeconds: 30 }, handler }]);
  });
  afterAll(async () => {
    await h.close();
  });

  it("carries the request's correlation id into the consumer's log line", async () => {
    const correlationId = "req-7f3a-correlation";
    const publisher = createPublisher(h.db, h.boss, correlationIdOrNew);
    const { envelope } = await withContext({ correlationId }, () =>
      withTransaction(h.db, (tx) => publisher.enqueue(tx, queue, { ping: 1 })),
    );
    expect(envelope.correlationId).toBe(correlationId);

    // "message consumed" is logged after the handler's transaction commits, so wait for it (M1-08).
    await until(() => h.lines.some((l) => l.msg === "message consumed"));
    const line = h.lines.find((l) => l.msg === "handler ran");
    expect(line).toMatchObject({
      service: "worker",
      level: "info",
      correlationId,
      messageId: envelope.messageId,
      data: { ping: 1 },
    });
    expect(h.lines.find((l) => l.msg === "message consumed")).toMatchObject({ correlationId, queue });
  });

  it("without a context, enqueue mints a fresh correlation id", async () => {
    const publisher = createPublisher(h.db, h.boss, correlationIdOrNew);
    const { envelope } = await withTransaction(h.db, (tx) => publisher.enqueue(tx, queue, { ping: 2 }));
    expect(envelope.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => h.lines.some((l) => l.messageId === envelope.messageId && l.msg === "handler ran"));
  });
});
