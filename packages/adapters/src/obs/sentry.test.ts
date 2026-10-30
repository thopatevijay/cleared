import { afterEach, describe, expect, it } from "vitest";
import { withContext } from "./context.ts";
import {
  createThresholdAlert,
  reportError,
  reportQuarantine,
  scrubEvent,
  sentryOptions,
  setAlertSink,
  type AlertSink,
} from "./sentry.ts";

function fakeSink() {
  const calls: { kind: string; arg: unknown; hint: unknown }[] = [];
  const sink: AlertSink = {
    captureException: (arg, hint) => (calls.push({ kind: "exception", arg, hint }), "id"),
    captureMessage: (arg, hint) => (calls.push({ kind: "message", arg, hint }), "id"),
  };
  return { sink, calls };
}

afterEach(() => {
  setAlertSink(undefined);
});

describe("obs sentry (M1-08)", () => {
  it("is disabled without a DSN and never sends default PII", () => {
    expect(sentryOptions({ service: "web", env: {} })).toMatchObject({
      enabled: false,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false },
    });
    expect(sentryOptions({ service: "worker", env: { SENTRY_DSN: "https://k@o.ingest/1" } }).enabled).toBe(
      true,
    );
  });

  it("tags the correlation id and workspace kind, never a workspace id", () => {
    const { sink, calls } = fakeSink();
    setAlertSink(sink);
    withContext({ correlationId: "c-9", workspaceId: "ws-secret-id" }, () => {
      reportError(new Error("boom"), { workspaceKind: "demo" });
      reportQuarantine("unowned capture");
    });
    expect(calls[0]?.hint).toMatchObject({ tags: { correlationId: "c-9", workspaceKind: "demo" } });
    expect(calls[1]).toMatchObject({ kind: "message", arg: "webhook quarantined: unowned capture" });
    expect(calls[1]?.hint).toMatchObject({ level: "warning" });
    expect(JSON.stringify(calls)).not.toContain("ws-secret-id");
  });

  it("scrubs cookies, auth headers, query tokens, user and emails from an event", () => {
    const event = scrubEvent({
      user: { email: "a@b.test", ip_address: "1.2.3.4" },
      request: {
        url: "https://x.test/api/auth/verify?token=abc123&lang=en",
        query_string: "token=abc123&lang=en",
        cookies: { __Host_cleared_session: "sess" },
        headers: { cookie: "__Host-cleared_session=sess", authorization: "Bearer t", "user-agent": "ua" },
        data: { email: "a@b.test" },
      },
      exception: { values: [{ type: "Error", value: "no user a@b.test" }] },
      breadcrumbs: [{ message: "sent to a@b.test" }],
    });
    const s = JSON.stringify(event);
    for (const bad of ["a@b.test", "abc123", "sess", "Bearer t", "1.2.3.4"]) expect(s).not.toContain(bad);
    expect(s).toContain("lang=en");
    expect(s).toContain("user-agent");
  });

  it("raises one warning above 5 failures per 10 min, then stays quiet for the window", () => {
    const { sink, calls } = fakeSink();
    setAlertSink(sink);
    let t = 0;
    const alert = createThresholdAlert({ message: "m", limit: 5, windowMs: 600_000, now: () => t });
    const fired = Array.from({ length: 8 }, () => ((t += 1_000), alert.record()));
    expect(fired).toEqual([false, false, false, false, false, true, false, false]);
    t += 11 * 60_000;
    expect(alert.record()).toBe(false); // window reset: 1 failure
    expect(calls).toHaveLength(1);
  });
});
