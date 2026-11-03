// Session-scoped routes (M1-05): POST /api/auth/sign-out, GET /api/workspace and (M4-03) PATCH
// /api/workspace. Each acts on the session's workspace only; any workspace or session id in the query or
// body is ignored.
import { canonicalTimeZone, LOCALES } from "@cleared/core";
import { platform, type WorkspaceRow } from "@cleared/db";
import { z } from "zod";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { isSupportedTimeZone } from "../locale.ts";
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
  return withRenewal(json(workspaceBody(ws, session.kind)), session);
}

export const PATCH_WORKSPACE_ROUTE = "PATCH /api/workspace";

const SettingsBody = z
  .strictObject({ locale: z.enum(LOCALES).optional(), timezone: z.string().max(64).optional() })
  .refine((b) => b.locale !== undefined || b.timezone !== undefined);

/**
 * M4-03: the seller's own settings: the language switch persists `locale` (AI explanations, emails and
 * PDF labels follow it) and the footer's time-zone control sets `timezone` (an IANA zone Intl knows).
 */
export async function patchWorkspace(req: Request, deps: Deps): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const scope = { scopeId: session.sessionId, route: PATCH_WORKSPACE_ROUTE, key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, async () => {
    const cid = correlationId(req);
    const parsed = SettingsBody.safeParse(await readJson(req));
    if (!parsed.success || (parsed.data.timezone !== undefined && !isSupportedTimeZone(parsed.data.timezone)))
      return apiError(400, "invalid_request", "Send a supported locale (en, hi) or an IANA time zone.", cid);
    const { locale, timezone } = parsed.data;
    const ws = await platform(deps.db).workspaces.updateSettings(session.workspaceId, {
      ...(locale === undefined ? {} : { locale }),
      ...(timezone === undefined ? {} : { timezone: canonicalTimeZone(timezone) }),
    });
    if (ws === null) return apiError(401, "unauthenticated", "Sign in or start a demo to continue.", cid);
    return withRenewal(json(workspaceBody(ws, session.kind)), session);
  });
}

function workspaceBody(ws: WorkspaceRow, kind: string) {
  return {
    workspace: {
      id: ws.id,
      kind: ws.kind,
      locale: ws.locale,
      timezone: ws.timezone,
      baseCurrency: ws.baseCurrency,
      expiresAt: ws.expiresAt?.toISOString() ?? null,
    },
    session: { kind },
  };
}
