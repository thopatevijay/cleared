// M1-08 AC (Sentry, DLQ arrival): with a test DSN pointed at a local capture server (a node:http server on 127.0.0.1; msw cannot intercept Sentry 11's transport), a message
// that exhausts its retries and lands in `<queue>.dlq` produces exactly one Sentry event, tagged with
// the message's correlationId, with no email or cookie in the payload. Sentry is initialised by the
// worker's own `initSentry` (the production path), with only the DSN overridden.
import { randomUUID } from "node:crypto";
import { setAlertSink } from "@cleared/adapters";
import { startSentryCapture, type SentryCapture } from "@cleared/adapters/testing/sentry-capture";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Handler } from "../src/consume.ts";
import { initSentry } from "../src/sentry.ts";
import { dbAvailable, harness, testQueue, until, type Harness } from "./helpers.ts";

const EMAIL = "seller.raj@example.test";
const COOKIE = "__Host-cleared_session=dlq-sess-999";

describe.skipIf(!dbAvailable)("Sentry: a DLQ arrival (compose Postgres)", () => {
  const queue = testQueue("sentry-dlq");
  let h: Harness;
  let capture: SentryCapture;

  const alwaysThrows: Handler = () => Promise.reject(new Error(`cannot sync for ${EMAIL} with ${COOKIE}`));

  beforeAll(async () => {
    capture = await startSentryCapture();
    expect(initSentry({ SENTRY_DSN: capture.dsn, NODE_ENV: "test" })).toBe(true);
    h = await harness([
      { queue: { name: queue, expireInSeconds: 30, retryLimit: 0 }, handler: alwaysThrows },
    ]);
  });
  afterAll(async () => {
    await h.close();
    setAlertSink(undefined);
    await Sentry.close(2_000);
    await capture.close();
  });

  it("produces one event tagged with correlationId, without the email or the cookie", async () => {
    const correlationId = randomUUID();
    const envelope = { messageId: randomUUID(), correlationId, data: { email: EMAIL } };
    await h.boss.send(queue, envelope);
    await until(() =>
      h.lines.some((l) => l.msg === "message dead-lettered" && l["messageId"] === envelope.messageId),
    );
    await Sentry.flush(5_000);

    const events = capture
      .events()
      .filter((e) => (e["tags"] as Record<string, string>)["correlationId"] === correlationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.["tags"]).toMatchObject({ correlationId, service: "worker" });
    const raw = capture
      .envelopes()
      .map((e) => e.raw)
      .join("\n");
    expect(raw).toContain(`message dead-lettered: ${queue}`);
    for (const leaked of [EMAIL, "dlq-sess-999", "__Host-cleared_session="])
      expect(raw).not.toContain(leaked);
  });
});
