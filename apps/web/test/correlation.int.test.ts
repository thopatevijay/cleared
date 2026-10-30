// M1-08 AC (correlation): a request with `x-correlation-id: <uuid>` produces log lines in the web, then
// in the worker (the enqueued job), then on the outbound PayPal call, all with that id, and the PayPal
// call's line carries PayPal's debug id. pino output is captured; msw replays the recorded M0-04
// capture (`fixtures/paypal/orders/get-capture-a.json`), so no network is used.
// AC (bad correlation id): `<script>` is replaced by a generated UUID.
import {
  correlationIdOrNew,
  createHttpClient,
  createLogger,
  createPayPalOrdersClient,
  createTokenProvider,
  type Logger,
} from "@cleared/adapters";
import { startReplay, type Replay } from "@cleared/adapters/testing/replay";
import { createPublisher, withTransaction } from "@cleared/db";
import type { Handler } from "@cleared/worker/src/consume.ts";
import type { Harness } from "@cleared/worker/test/helpers.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveCorrelationId } from "../src/server/request-context.ts";
import { withRoute } from "../src/server/with-route.ts";
import { dbAvailable } from "./support/db-available.ts";

type Line = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPTURE_ID = "6BC19320SY177903T"; // the recorded capture
const DEBUG_ID = "f561822f3f12c"; // its recorded `paypal-debug-id`

function capture(service: string): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const log = createLogger({
    service,
    destination: { write: (s: string) => void lines.push(JSON.parse(s) as Line) },
  });
  return { log, lines };
}

describe("correlation id: inbound header validation", () => {
  it('replaces "<script>" (and any non-UUID) with a generated UUID', async () => {
    expect(resolveCorrelationId("<script>")).toMatch(UUID);
    expect(resolveCorrelationId("req-123")).toMatch(UUID);
    expect(resolveCorrelationId(null)).toMatch(UUID);
    const given = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(resolveCorrelationId(given)).toBe(given);

    const web = capture("web");
    const route = withRoute("/api/test", () => new Response(null, { status: 204 }), { log: web.log });
    const res = await route(
      new Request("http://localhost/api/test", { headers: { "x-correlation-id": "<script>" } }),
    );
    const cid = res.headers.get("x-correlation-id") ?? "";
    expect(cid).toMatch(UUID);
    expect(JSON.stringify(web.lines)).not.toContain("<script>");
    expect(web.lines[0]).toMatchObject({
      msg: "request",
      correlationId: cid,
      route: "/api/test",
      status: 204,
    });
  });

  it("an unhandled route error → 500 envelope carrying the same id as the header", async () => {
    const web = capture("web");
    const route = withRoute(
      "/api/boom",
      () => {
        throw new Error("boom");
      },
      { log: web.log },
    );
    const res = await route(new Request("http://localhost/api/boom"));
    const body = (await res.json()) as { error: { code: string; correlationId: string } };
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.correlationId).toBe(res.headers.get("x-correlation-id"));
  });
});

describe.skipIf(!dbAvailable)("correlation id: web → worker → PayPal (integration)", () => {
  // Imported lazily: the worker's test helpers probe Postgres at import time.
  let h: Harness;
  let until: (check: () => boolean) => Promise<void>;
  let replay: Replay;
  const queue = `test.m1-08.corr.${crypto.randomUUID().slice(0, 8)}`;

  const handler: Handler = async (data, { log }) => {
    const { captureId } = z.object({ captureId: z.string() }).parse(data);
    const http = createHttpClient({ vendor: "paypal", timeoutMs: 10_000, maxRetries: 0, log });
    const tokens = createTokenProvider({
      http,
      baseUrl: "https://api-m.sandbox.paypal.com",
      credentials: { clientId: "replay-m1-08", clientSecret: "replay" },
      cache: new Map(),
    });
    const captured = await createPayPalOrdersClient({ http, tokens }).getCapture(captureId);
    log.info({ captureStatus: captured.status }, "capture synced");
  };

  beforeAll(async () => {
    const helpers = await import("@cleared/worker/test/helpers.ts");
    until = (check) => helpers.until(check);
    replay = startReplay(["paypal/oauth/token", "paypal/orders/get-capture-a"]);
    h = await helpers.harness([{ queue: { name: queue, expireInSeconds: 30 }, handler }]);
  });
  afterAll(async () => {
    replay.close();
    await h.close();
  });

  it("one id on the web request line, the worker's job lines and the PayPal call (with debug id)", async () => {
    const cid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const web = capture("web");
    const publisher = createPublisher(h.db, h.boss, correlationIdOrNew);
    const route = withRoute(
      "/api/test/capture-sync",
      async () => {
        await withTransaction(h.db, (tx) => publisher.enqueue(tx, queue, { captureId: CAPTURE_ID }));
        web.log.info({ queue }, "capture sync enqueued");
        return Response.json({ queued: true }, { status: 202 });
      },
      { log: web.log },
    );

    const res = await route(
      new Request("http://localhost/api/test/capture-sync", {
        method: "POST",
        headers: { "x-correlation-id": cid },
      }),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("x-correlation-id")).toBe(cid);
    await until(() => h.lines.some((l) => l.msg === "message consumed" && l["queue"] === queue));

    expect(web.lines.map((l) => [l["service"], l.msg, l["correlationId"]])).toEqual([
      ["web", "capture sync enqueued", cid],
      ["web", "request", cid],
    ]);
    const workerLines = h.lines.filter((l) => l["correlationId"] === cid);
    expect(workerLines.map((l) => l.msg)).toEqual([
      "outbound call", // POST /v1/oauth2/token
      "outbound call", // GET /v2/payments/captures/:id
      "capture synced",
      "message consumed",
    ]);
    expect(workerLines[1]).toMatchObject({
      service: "worker",
      vendor: "paypal",
      method: "GET",
      route: "/v2/payments/captures/:id",
      status: 200,
      attempt: 1,
      paypalDebugId: DEBUG_ID,
    });
    expect(replay.unused()).toEqual([]);
    expect(JSON.stringify([...web.lines, ...h.lines])).not.toMatch(/Bearer |Basic /);
  });
});
