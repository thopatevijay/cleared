// Typed failures of the shared HTTP client (ADR 0011).

/** Base class: every failure the client raises carries the vendor, method and URL. */
export class HttpError extends Error {
  readonly vendor: string;
  readonly method: string;
  readonly url: string;

  constructor(message: string, vendor: string, method: string, url: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.vendor = vendor;
    this.method = method;
    this.url = url;
  }
}

/**
 * No response within the timeout. For a write the outcome is UNKNOWN: the vendor may have applied it.
 * Callers re-read the resource (or replay with the same idempotency key) before acting again.
 */
export class HttpTimeoutError extends HttpError {
  readonly timeoutMs: number;
  readonly outcomeUnknown: boolean;

  constructor(vendor: string, method: string, url: string, timeoutMs: number, options?: ErrorOptions) {
    super(`${vendor} ${method} ${url} timed out after ${String(timeoutMs)} ms`, vendor, method, url, options);
    this.name = "HttpTimeoutError";
    this.timeoutMs = timeoutMs;
    this.outcomeUnknown = method !== "GET" && method !== "HEAD";
  }
}

/** A non-2xx response (after any retries). */
export class HttpStatusError extends HttpError {
  readonly status: number;
  readonly debugId: string | undefined;
  readonly bodyText: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    vendor: string,
    method: string,
    url: string,
    status: number,
    bodyText: string,
    headers: Readonly<Record<string, string>>,
    debugId: string | undefined,
  ) {
    const suffix = debugId === undefined ? "" : ` (debug id ${debugId})`;
    super(`${vendor} ${method} ${url} → ${String(status)}${suffix}`, vendor, method, url);
    this.name = "HttpStatusError";
    this.status = status;
    this.bodyText = bodyText;
    this.headers = headers;
    this.debugId = debugId;
  }
}

/** The breaker is open: the call was not attempted. */
export class CircuitOpenError extends HttpError {
  readonly retryAt: number;

  constructor(vendor: string, method: string, url: string, retryAt: number) {
    super(`${vendor} circuit open; not calling ${method} ${url}`, vendor, method, url);
    this.name = "CircuitOpenError";
    this.retryAt = retryAt;
  }
}

/** A transport failure that is not a timeout (DNS, reset). Counted like a 5xx. */
export class HttpNetworkError extends HttpError {
  constructor(vendor: string, method: string, url: string, options?: ErrorOptions) {
    super(`${vendor} ${method} ${url} failed before a response`, vendor, method, url, options);
    this.name = "HttpNetworkError";
  }
}
