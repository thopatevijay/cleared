// M1-08 AC (Sentry, route error): with a test DSN pointed at a local capture server (a node:http server on 127.0.0.1; msw cannot intercept Sentry 11's transport), a thrown
// route error produces exactly one event, tagged with the request's correlationId, with no email or
// cookie in the payload. The server SDK under @sentry/nextjs is @sentry/node; it is initialised here
// with the same shared options (`sentryOptions`) the web's sentry.server.config.ts uses.
import { createLogger, sentryOptions, setAlertSink } from "@cleared/adapters";
import { startSentryCapture, type SentryCapture } from "@cleared/adapters/testing/sentry-capture";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRoute } from "../src/server/with-route.ts";

const EMAIL = "jane.buyer@example.test";
const COOKIE = "__Host-cleared_session=sess-abc-123";

describe("Sentry: a thrown route error", () => {
  let capture: SentryCapture;

  beforeAll(async () => {
    capture = await startSentryCapture();
    Sentry.init(sentryOptions({ service: "web", dsn: capture.dsn, env: {} }));
    setAlertSink(Sentry);
  });
  afterAll(async () => {
    setAlertSink(undefined);
    await Sentry.close(2_000);
    await capture.close();
  });

  it("produces one event, tagged with correlationId, without the email or the cookie", async () => {
    const cid = "9a1f0c4e-6c1b-4d2e-8f3a-2b7c9d0e1f23";
    const lines: string[] = [];
    const log = createLogger({ service: "web", destination: { write: (s: string) => void lines.push(s) } });
    const route = withRoute(
      "/api/test/boom",
      () => {
        throw new Error(`no workspace for ${EMAIL} (cookie ${COOKIE})`);
      },
      { log },
    );
    const res = await route(
      new Request("http://localhost/api/test/boom?token=t0k3n", {
        headers: { "x-correlation-id": cid, cookie: COOKIE },
      }),
    );
    expect(res.status).toBe(500);
    await Sentry.flush(5_000);

    const events = capture.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.["tags"]).toMatchObject({ correlationId: cid, service: "web" });
    const raw = capture
      .envelopes()
      .map((e) => e.raw)
      .join("\n");
    expect(raw).toContain("no workspace for [email]");
    for (const leaked of [EMAIL, "sess-abc-123", "__Host-cleared_session="])
      expect(raw).not.toContain(leaked);
    for (const leaked of [EMAIL, "sess-abc-123"]) expect(lines.join("")).not.toContain(leaked);
  });
});
