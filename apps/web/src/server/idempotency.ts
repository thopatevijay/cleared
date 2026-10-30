// Idempotency-Key replay (ADR 0003, M1-05). The first request with a key claims the
// (scope, route, key) row, runs, and stores its status, safe headers and JSON body with the body's
// sha256; a repeat gets the stored response back. A request still in flight gets 409; a handler that
// throws or answers 5xx frees the key so the client can retry. `Set-Cookie` is never stored.
import { platform } from "@cleared/db";
import { z } from "zod";
import type { Deps } from "./deps.ts";
import { apiError, correlationId } from "./respond.ts";
import { sha256Hex } from "./session.ts";

export const REPLAY_HEADER = "idempotent-replay";
const STORED_HEADERS = ["content-type", "retry-after", "location", "cache-control"] as const;

const StoredResponse = z.object({ headers: z.record(z.string(), z.string()), body: z.string() });
type StoredResponse = z.infer<typeof StoredResponse>;

export interface IdempotencyScope {
  /** session id, or the anonymous scope id for routes that run before a session exists */
  readonly scopeId: string;
  readonly route: string;
  readonly key: string;
}

export async function withIdempotency(
  req: Request,
  deps: Deps,
  scope: IdempotencyScope,
  handler: () => Promise<Response>,
): Promise<Response> {
  const keys = platform(deps.db).idempotencyKeys;
  const claimed = await keys.put({
    sessionId: scope.scopeId,
    route: scope.route,
    key: scope.key,
    responseHash: null,
  });
  if (!claimed) return replay(req, await keys.get(scope.scopeId, scope.route, scope.key));

  let res: Response;
  try {
    res = await handler();
  } catch (error) {
    await keys.release(scope.scopeId, scope.route, scope.key);
    throw error;
  }
  if (res.status >= 500) {
    await keys.release(scope.scopeId, scope.route, scope.key);
    return res;
  }
  const body = await res.clone().text();
  const headers: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  const stored: StoredResponse = { headers, body };
  await keys.complete({
    sessionId: scope.scopeId,
    route: scope.route,
    key: scope.key,
    responseHash: sha256Hex(body),
    responseStatus: res.status,
    responseBody: stored,
  });
  return res;
}

function replay(
  req: Request,
  row: { responseStatus: number | null; responseBody: unknown } | null,
): Response {
  const stored = StoredResponse.safeParse(row?.responseBody);
  if (row === null || row.responseStatus === null || !stored.success) {
    return apiError(
      409,
      "request_in_progress",
      "This request is still being processed. Try again shortly.",
      correlationId(req),
    );
  }
  return new Response(stored.data.body, {
    status: row.responseStatus,
    headers: { ...stored.data.headers, [REPLAY_HEADER]: "true" },
  });
}
