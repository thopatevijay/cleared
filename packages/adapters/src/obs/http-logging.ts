// Outbound-call logging for the shared HTTP client (M1-08): one line per attempt with the vendor, the
// route template (ids replaced by `:id`, no query string), the status, the duration, the attempt
// number, the correlation id and, for PayPal, the `paypal-debug-id`, so a judge-visible failure can be
// traced to PayPal's own logs.
import type { Logger } from "pino";

export interface OutboundAttempt {
  readonly vendor: string;
  readonly method: string;
  readonly url: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly correlationId: string;
  /** Absent on a timeout or network error. */
  readonly status?: number;
  readonly debugId?: string | undefined;
  /** `timeout` | `network` when no response arrived. */
  readonly failure?: "timeout" | "network";
}

/** An id-like path segment: 10+ characters with a digit (PayPal ids, uuids, tracker keys). */
const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9._~-]{10,}$/;

/** `https://api-m…/v2/payments/captures/6BC19320SY177903T?x=1` → `/v2/payments/captures/:id`. */
export function routeTemplate(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return path
    .split("/")
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
}

export function logOutboundAttempt(log: Logger, a: OutboundAttempt): void {
  const line = {
    vendor: a.vendor,
    method: a.method,
    route: routeTemplate(a.url),
    attempt: a.attempt,
    durationMs: a.durationMs,
    correlationId: a.correlationId,
    ...(a.status === undefined ? {} : { status: a.status }),
    ...(a.debugId === undefined ? {} : { paypalDebugId: a.debugId }),
    ...(a.failure === undefined ? {} : { failure: a.failure }),
  };
  const ok = a.status !== undefined && a.status >= 200 && a.status < 400;
  if (ok) log.info(line, "outbound call");
  else log.warn(line, "outbound call failed");
}
