// Ack time (M1-04 AC): 50 distinct fixture deliveries through the route handler against the local
// Postgres (verify with a warm cert cache, raw insert, enqueue, commit), p95 < 500 ms. Each post is the
// real capture delivery with a fresh event id, re-signed with the runtime key.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postPayPalWebhook } from "../../src/server/handlers/paypal-webhook.ts";
import { dbAvailable } from "../support/db-available.ts";
import {
  cleanup,
  counts,
  loadDeliveries,
  post,
  resign,
  RESIGN_WEBHOOK_ID,
  routeDeps,
  seedResignKey,
  sentAt,
  server,
  testProducer,
} from "./support.ts";

const N = 50;
const [, capture] = loadDeliveries("deliveries").find(([n]) => n === "payment-capture-completed.json") ?? [];
if (capture === undefined) throw new Error("fixture deliveries/payment-capture-completed.json missing");
const ids = Array.from({ length: N }, () => `WH-ACK-${randomUUID()}`);

describe.skipIf(!dbAvailable)("ack time", () => {
  beforeAll(() => {
    server.listen({ onUnhandledFrame: "error" });
  });
  afterAll(async () => {
    server.close();
    await cleanup(ids);
    await (await testProducer()).stop({ graceful: false });
  });

  it(`p95 < 500 ms over ${String(N)} posts`, async () => {
    const deps = await routeDeps({ webhookId: RESIGN_WEBHOOK_ID, now: sentAt(capture) });
    seedResignKey(deps.verifier, capture, sentAt(capture));
    const original = (JSON.parse(capture.raw_body) as { id: string }).id;
    const ms: number[] = [];
    for (const id of ids) {
      const d = { ...capture, raw_body: capture.raw_body.replace(original, id) };
      const t0 = performance.now();
      const res = await postPayPalWebhook(post(d.raw_body, resign(d)), deps);
      ms.push(performance.now() - t0);
      expect(res.status).toBe(200);
    }
    ms.sort((a, b) => a - b);
    const p = (q: number): number => Math.round((ms[Math.ceil(q * N) - 1] ?? 0) * 10) / 10;
    console.log(
      `[M1-04 ack time] n=${String(N)} p50=${String(p(0.5))}ms p95=${String(p(0.95))}ms max=${String(p(1))}ms`,
    );
    expect(p(0.95)).toBeLessThan(500);
    expect(await counts(ids)).toEqual({ rows: N, jobs: N });
  });
});
