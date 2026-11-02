// M3-05: GET /api/cash-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD (cash-calendar.md). The session's workspace
// only. Both params or neither (the default range); offset-free days in the workspace zone, `to` included,
// at most 92 days. 400 `invalid_request` otherwise.
import { CashRangeSchema, type CashRange, type WorkspaceId } from "@cleared/core";
import type { Deps } from "../deps.ts";
import { cashCalendar } from "../cash/calendar.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";

/** `undefined`: the query is invalid; `null`: no range given (the default). */
export function parseRange(url: URL): CashRange | null | undefined {
  const params = Object.fromEntries(url.searchParams.entries());
  if (Object.keys(params).length === 0) return null;
  const r = CashRangeSchema.safeParse(params);
  return r.success ? r.data : undefined;
}

export async function getCashCalendar(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const range = parseRange(new URL(req.url));
  if (range === undefined)
    return apiError(
      400,
      "invalid_request",
      "Send both `from` and `to` as YYYY-MM-DD, `to` not before `from`, at most 92 days.",
      correlationId(req),
    );
  const body = await cashCalendar(deps, session.workspaceId as WorkspaceId, range);
  return withRenewal(json(body), session);
}
