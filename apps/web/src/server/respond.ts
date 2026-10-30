// JSON responses and the ADR 0003 error envelope for route handlers.
import { randomUUID } from "node:crypto";
import { errorEnvelope } from "@cleared/core";

export const CORRELATION_HEADER = "x-correlation-id";

/** The caller's correlation id when it is sane, else a new one. */
export function correlationId(req: Request): string {
  const given = req.headers.get(CORRELATION_HEADER);
  return given !== null && /^[A-Za-z0-9._-]{8,128}$/.test(given) ? given : randomUUID();
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
): Response {
  return json(errorEnvelope({ code, message, correlationId: cid }), status, {
    [CORRELATION_HEADER]: cid,
    ...headers,
  });
}
