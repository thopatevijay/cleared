// JSON responses and the ADR 0003 error envelope for route handlers.
import { errorEnvelope } from "@cleared/core";
import { CORRELATION_HEADER, requestCorrelationId } from "./request-context.ts";

export { CORRELATION_HEADER };

/**
 * The request's correlation id: the one `withRoute` set (M1-08), else the inbound header when it is a
 * UUID, else a new one.
 */
export function correlationId(req: Request): string {
  return requestCorrelationId(req);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  cid: string,
  headers: Record<string, string> = {},
  details: Readonly<Record<string, unknown>> | null = null,
): Response {
  return json(errorEnvelope({ code, message, correlationId: cid, details }), status, {
    [CORRELATION_HEADER]: cid,
    ...headers,
  });
}
