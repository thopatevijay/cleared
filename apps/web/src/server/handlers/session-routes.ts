// Session-scoped routes (M1-05): POST /api/auth/sign-out and GET /api/workspace. Both act on the
// session's workspace only; any workspace or session id in the query or body is ignored.
import { platform } from "@cleared/db";
import { checkMutation } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { clearedSessionCookie, requireSession, withRenewal } from "../session.ts";

export const SIGN_OUT_ROUTE = "POST /api/auth/sign-out";

export async function postSignOut(req: Request, deps: Deps): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const scope = { scopeId: session.sessionId, route: SIGN_OUT_ROUTE, key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, async () => {
    await platform(deps.db).auth.deleteSession(session.sessionId, session.workspaceId);
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  });
}

/** The caller's workspace (what M1-07's shell shows); the first scoped read route. */
export async function getWorkspace(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = await platform(deps.db).workspaces.get(session.workspaceId);
  if (ws === null)
    return apiError(401, "unauthenticated", "Sign in or start a demo to continue.", correlationId(req));
  const body = {
    workspace: {
      id: ws.id,
      kind: ws.kind,
      locale: ws.locale,
      timezone: ws.timezone,
      baseCurrency: ws.baseCurrency,
      expiresAt: ws.expiresAt?.toISOString() ?? null,
    },
    session: { kind: session.kind },
  };
  return withRenewal(json(body), session);
}
