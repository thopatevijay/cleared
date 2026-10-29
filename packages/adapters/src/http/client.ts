// The ONE shared outbound HTTP client (ADR 0011). Every vendor call goes through `createHttpClient`:
// per-call timeout, retries only on timeout / 5xx / 429 with full-jitter backoff and Retry-After,
// one circuit breaker counting only those failures, a correlation-id header, the PayPal debug id
// captured on every response, and an `onExchange` hook (the fixture recorder).
import { randomUUID } from "node:crypto";
import { createBreaker, type Breaker, type BreakerOptions } from "./breaker.ts";
import { CircuitOpenError, HttpNetworkError, HttpStatusError, HttpTimeoutError } from "./errors.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Overrides the client's default timeout for this call. */
  readonly timeoutMs?: number;
  /**
   * Safe to repeat (GET, or a write carrying an idempotency key such as `PayPal-Request-Id`).
   * Defaults to true for GET/HEAD. Timeouts, network errors and 5xx retry only when idempotent;
   * 429 always retries (the request was rejected before processing).
   */
  readonly idempotent?: boolean;
  readonly correlationId?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
  /** `paypal-debug-id` (PayPal); undefined for vendors that do not send one. */
  readonly debugId: string | undefined;
  readonly correlationId: string;
  readonly attempts: number;
}

/** One request/response pair as seen on the wire; fed to `onExchange` for every attempt. */
export interface Exchange {
  readonly vendor: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly request: {
    readonly method: HttpMethod;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | undefined;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

export interface HttpClientOptions {
  readonly vendor: string;
  readonly timeoutMs: number;
  /** Retries after the first attempt (default 2, so at most 3 attempts). */
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** A Retry-After longer than this is not waited for; the call fails instead (default 30 s). */
  readonly maxRetryAfterMs?: number;
  readonly breaker?: Partial<BreakerOptions>;
  readonly onExchange?: (exchange: Exchange) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface HttpClient {
  readonly vendor: string;
  /** Resolves on 2xx; throws HttpStatusError / HttpTimeoutError / HttpNetworkError / CircuitOpenError. */
  request(req: HttpRequest): Promise<HttpResponse>;
  readonly breaker: Breaker;
}

export const CORRELATION_HEADER = "x-correlation-id";
export const PAYPAL_DEBUG_HEADER = "paypal-debug-id";

/** PayPal: 10 s per call (ADR 0011). */
export const VENDOR_TIMEOUTS_MS = { paypal: 10_000, openai: 60_000, resend: 10_000 } as const;

type Attempt =
  | { readonly kind: "response"; readonly res: HttpResponse; readonly retryAfterMs: number | undefined }
  | { readonly kind: "timeout"; readonly error: HttpTimeoutError }
  | { readonly kind: "network"; readonly error: HttpNetworkError };

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const cfg = {
    maxRetries: options.maxRetries ?? 2,
    baseDelayMs: options.baseDelayMs ?? 250,
    maxDelayMs: options.maxDelayMs ?? 4_000,
    maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
  };
  const breaker = createBreaker({ now: cfg.now, ...options.breaker });

  async function attemptOnce(req: HttpRequest, correlationId: string, attempt: number): Promise<Attempt> {
    const timeoutMs = req.timeoutMs ?? options.timeoutMs;
    const headers: Record<string, string> = { ...req.headers, [CORRELATION_HEADER]: correlationId };
    const started = cfg.now();
    let raw: Response;
    try {
      raw = await cfg.fetch(req.url, {
        method: req.method,
        headers,
        body: req.body ?? null,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) {
        return {
          kind: "timeout",
          error: new HttpTimeoutError(options.vendor, req.method, req.url, timeoutMs, { cause: err }),
        };
      }
      return {
        kind: "network",
        error: new HttpNetworkError(options.vendor, req.method, req.url, { cause: err }),
      };
    }
    const bodyText = await raw.text();
    const resHeaders = Object.fromEntries(raw.headers.entries());
    options.onExchange?.({
      vendor: options.vendor,
      attempt,
      durationMs: cfg.now() - started,
      request: { method: req.method, url: req.url, headers, body: req.body },
      response: { status: raw.status, headers: resHeaders, body: bodyText },
    });
    const res: HttpResponse = {
      status: raw.status,
      headers: resHeaders,
      bodyText,
      debugId: resHeaders[PAYPAL_DEBUG_HEADER],
      correlationId,
      attempts: attempt,
    };
    return { kind: "response", res, retryAfterMs: parseRetryAfter(resHeaders["retry-after"], cfg.now()) };
  }

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const correlationId = req.correlationId ?? randomUUID();
    const idempotent = req.idempotent ?? (req.method === "GET" || req.method === "HEAD");
    for (let attempt = 1; ; attempt++) {
      const gate = breaker.allow();
      if (!gate.ok) throw new CircuitOpenError(options.vendor, req.method, req.url, gate.retryAt);

      const result = await attemptOnce(req, correlationId, attempt);
      const counted = isCounted(result);
      breaker.record(counted);
      const retryable = counted && (idempotent || (result.kind === "response" && result.res.status === 429));
      const retryAfterMs = result.kind === "response" ? result.retryAfterMs : undefined;
      const canWait = retryAfterMs === undefined || retryAfterMs <= cfg.maxRetryAfterMs;

      if (retryable && attempt <= cfg.maxRetries && canWait) {
        await cfg.sleep(retryAfterMs ?? backoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs, cfg.random));
        continue;
      }
      if (result.kind !== "response") throw result.error;
      const { res } = result;
      if (res.status >= 200 && res.status < 300) return res;
      throw new HttpStatusError(
        options.vendor,
        req.method,
        req.url,
        res.status,
        res.bodyText,
        res.headers,
        res.debugId,
      );
    }
  }

  return { vendor: options.vendor, request, breaker };
}

/** Timeouts, transport failures, 5xx and 429 count toward the breaker; 4xx do not. */
function isCounted(result: Attempt): boolean {
  if (result.kind !== "response") return true;
  return result.res.status === 429 || result.res.status >= 500;
}

/** Full jitter: uniform in [0, min(max, base·2^(attempt-1))]. */
export function backoff(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/** Retry-After as delta-seconds or an HTTP date; undefined when absent or unparseable. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}
