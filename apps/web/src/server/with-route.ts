// The wrapper every API route handler goes through (M1-08):
// - resolves the correlation id (UUID-only, `request-context.ts`) and runs the handler inside it, so
//   logs, enqueued jobs and outbound calls all carry it
// - returns it in the `x-correlation-id` response header (error envelopes carry it in the body)
// - writes one request line: method, route template, status, duration ms (and `webhook_ack_ms`)
// - turns an unhandled error into a 500 error envelope and one Sentry event
import { reportError, withContext, type Logger } from "@cleared/adapters";
import { errorEnvelope } from "@cleared/core";
import { CORRELATION_HEADER, resolveCorrelationId, webLogger } from "./request-context.ts";

export interface RouteOptions {
  /** Webhook receivers: the request line also carries `webhook_ack_ms` (M4-06 reads it). */
  readonly webhookAck?: boolean;
  /** `debug` for probes (`/healthz`, `/readyz`) so Render's health checks don't flood the logs. */
  readonly logLevel?: "info" | "debug";
  readonly log?: Logger;
  readonly now?: () => number;
}

type Handler<A extends unknown[]> = (req: Request, ...rest: A) => Response | Promise<Response>;

export function withRoute<A extends unknown[]>(
  route: string,
  handler: Handler<A>,
  opts: RouteOptions = {},
): (req: Request, ...rest: A) => Promise<Response> {
  const now = opts.now ?? (() => performance.now());
  return (req, ...rest) => {
    const correlationId = resolveCorrelationId(req.headers.get(CORRELATION_HEADER));
    return withContext({ correlationId }, async () => {
      const log = opts.log ?? webLogger();
      const started = now();
      let res: Response;
      try {
        res = await handler(req, ...rest);
      } catch (error) {
        log.error({ route, method: req.method, err: error }, "request failed");
        reportError(error);
        res = Response.json(
          errorEnvelope({
            code: "internal_error",
            message: "Something went wrong. Try again.",
            correlationId,
          }),
          { status: 500, headers: { "cache-control": "no-store" } },
        );
      }
      const out = withHeader(res, correlationId);
      const durationMs = Math.round(now() - started);
      const line = {
        method: req.method,
        route,
        status: out.status,
        durationMs,
        ...(opts.webhookAck === true ? { webhook_ack_ms: durationMs } : {}),
      };
      log[opts.logLevel ?? "info"](line, "request");
      return out;
    });
  };
}

/** Sets the correlation header; re-wraps a response whose headers are immutable. */
function withHeader(res: Response, correlationId: string): Response {
  try {
    res.headers.set(CORRELATION_HEADER, correlationId);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(CORRELATION_HEADER, correlationId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}
