import { describe, expect, it } from "vitest";
import { createHttpClient, parseRetryAfter, type Exchange, type HttpClientOptions } from "./client.ts";
import { CircuitOpenError, HttpStatusError, HttpTimeoutError } from "./errors.ts";

type Step = { status: number; headers?: Record<string, string>; body?: string } | "hang";

function fakeFetch(steps: Step[]): { fetch: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  const f: typeof fetch = (_input, init) => {
    calls.push(init ?? {});
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step === undefined) throw new Error("no step");
    if (step === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      });
    }
    return Promise.resolve(
      new Response(step.body ?? "{}", { status: step.status, headers: step.headers ?? {} }),
    );
  };
  return { fetch: f, calls };
}

function client(steps: Step[], extra: Partial<HttpClientOptions> = {}) {
  const ff = fakeFetch(steps);
  const sleeps: number[] = [];
  const http = createHttpClient({
    vendor: "paypal",
    timeoutMs: 1_000,
    fetch: ff.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    ...extra,
  });
  return { http, calls: ff.calls, sleeps };
}

const GET = { method: "GET", url: "https://api.test/x" } as const;

describe("createHttpClient", () => {
  it("raises HttpTimeoutError when the vendor does not answer in time (outcome unknown for writes)", async () => {
    const { http } = client(["hang"], { timeoutMs: 20, maxRetries: 0 });
    const err = await http
      .request({ method: "POST", url: "https://api.test/w", body: "{}" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect((err as HttpTimeoutError).outcomeUnknown).toBe(true);
    expect((err as HttpTimeoutError).timeoutMs).toBe(20);
  });

  it("retries a timed-out GET, then succeeds", async () => {
    const { http, calls } = client(["hang", { status: 200 }], { timeoutMs: 20 });
    const res = await http.request(GET);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("retries on 503 with full-jitter backoff and keeps one correlation id", async () => {
    const seen: Exchange[] = [];
    const { http, calls, sleeps } = client([{ status: 503 }, { status: 503 }, { status: 200 }], {
      onExchange: (e) => seen.push(e),
    });
    const res = await http.request(GET);
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([125, 250]); // 0.5 × min(4000, 250·2^(n-1))
    expect(new Set(seen.map((e) => e.request.headers["x-correlation-id"])).size).toBe(1);
    expect(seen.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("honours Retry-After on 429 (seconds and HTTP date)", async () => {
    const { http, sleeps } = client([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
    await http.request(GET);
    expect(sleeps).toEqual([2000]);
    expect(parseRetryAfter("Thu, 29 Oct 2026 00:00:10 GMT", Date.parse("2026-10-29T00:00:00Z"))).toBe(10_000);
  });

  it("retries a 429 even on a non-idempotent write (rejected before processing), but not a 503", async () => {
    const a = client([{ status: 429 }, { status: 201 }]);
    expect((await a.http.request({ method: "POST", url: "https://api.test/w" })).status).toBe(201);
    const b = client([{ status: 503 }, { status: 201 }]);
    await expect(b.http.request({ method: "POST", url: "https://api.test/w" })).rejects.toBeInstanceOf(
      HttpStatusError,
    );
    expect(b.calls).toHaveLength(1);
    const c = client([{ status: 503 }, { status: 201 }]);
    expect(
      (await c.http.request({ method: "POST", url: "https://api.test/w", idempotent: true })).status,
    ).toBe(201);
  });

  it("gives up after maxRetries and throws the last status", async () => {
    const { http, calls } = client([{ status: 503 }]);
    const err = await http.request(GET).catch((e: unknown) => e);
    expect((err as HttpStatusError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it.each([400, 401, 404, 422])("does not retry a %i", async (status) => {
    const { http, calls, sleeps } = client([{ status }, { status: 200 }]);
    const err = await http.request(GET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("surfaces paypal-debug-id on success and on errors", async () => {
    const ok = client([{ status: 200, headers: { "paypal-debug-id": "abc123" } }]);
    expect((await ok.http.request(GET)).debugId).toBe("abc123");
    const bad = client([{ status: 422, headers: { "paypal-debug-id": "def456" }, body: '{"name":"X"}' }]);
    const err = (await bad.http.request(GET).catch((e: unknown) => e)) as HttpStatusError;
    expect(err.debugId).toBe("def456");
    expect(err.bodyText).toBe('{"name":"X"}');
  });

  it("opens the breaker after 5 counted failures, ignores 4xx, and half-opens after the cool-down", async () => {
    let t = 0;
    const { http, calls } = client([{ status: 503 }], { maxRetries: 0, now: () => t });
    for (let i = 0; i < 4; i++) await http.request(GET).catch(() => undefined);
    expect(http.breaker.state()).toBe("closed");
    await http.request(GET).catch(() => undefined);
    expect(http.breaker.state()).toBe("open");
    await expect(http.request(GET)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toHaveLength(5);
    t = 30_000;
    expect(http.breaker.state()).toBe("half-open");
    await http.request(GET).catch(() => undefined); // trial fails → open again
    expect(http.breaker.state()).toBe("open");
    expect(calls).toHaveLength(6);
  });

  it("does not count 4xx toward the breaker", async () => {
    const { http } = client([{ status: 404 }], { maxRetries: 0 });
    for (let i = 0; i < 8; i++) await http.request(GET).catch(() => undefined);
    expect(http.breaker.state()).toBe("closed");
  });

  it("sends the correlation id header and caller headers", async () => {
    const { http, calls } = client([{ status: 200 }]);
    const res = await http.request({
      ...GET,
      headers: { accept: "application/json" },
      correlationId: "corr-1",
    });
    expect(res.correlationId).toBe("corr-1");
    expect(calls[0]?.headers).toMatchObject({ accept: "application/json", "x-correlation-id": "corr-1" });
  });
});
