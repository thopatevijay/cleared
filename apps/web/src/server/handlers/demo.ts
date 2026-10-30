// POST /api/demo (M1-05, ADR 0007): an anonymous demo workspace and session, within the per-IP and
// global caps (checked under an advisory lock in the creating transaction).
import { compareInstants, DEMO_WORKSPACE_EXPIRES_AT, type Instant } from "@cleared/core";
import { platform, withTransaction, type Tx } from "@cleared/db";
import { z } from "zod";
import { checkDemoCaps } from "../caps.ts";
import { anonymousScopeId, clientIp, clientIpSource, ipHash } from "../client-ip.ts";
import { webLogger } from "../request-context.ts";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { DEFAULT_TIMEZONE, isSupportedTimeZone, localeFrom } from "../locale.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { startSession } from "../session.ts";
import { capped } from "./capped.ts";

export const DEMO_ROUTE = "POST /api/demo";
/** Demo amounts show in USD (the sandbox buyer pays in USD). */
export const DEMO_BASE_CURRENCY = "USD";

const Body = z.object({ timezone: z.string().max(64).optional() });

export async function postDemo(req: Request, deps: Deps): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const ip = ipHash(clientIp(req.headers), deps.config.sessionSecret);
  webLogger().info({ ipSource: clientIpSource(req.headers) }, "demo client ip source");
  const scope = { scopeId: anonymousScopeId(ip), route: DEMO_ROUTE, key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, async () => {
    const cid = correlationId(req);
    const parsed = Body.safeParse(await readJson(req));
    const timezone = parsed.success ? (parsed.data.timezone ?? DEFAULT_TIMEZONE) : null;
    if (timezone === null || !isSupportedTimeZone(timezone)) {
      return apiError(400, "invalid_request", "Send an empty body or a valid time zone.", cid);
    }
    if (compareInstants(deps.now().toISOString() as Instant, DEMO_WORKSPACE_EXPIRES_AT) >= 0) {
      return apiError(410, "demo_closed", "The demo has ended.", cid);
    }
    const locale = localeFrom(req.headers.get("accept-language"));
    const out = await withTransaction(deps.db, (tx) => createDemo(deps, tx, req, { ip, timezone, locale }));
    if (out instanceof Response) return out;
    return json({ workspace: { kind: "demo", expiresAt: DEMO_WORKSPACE_EXPIRES_AT } }, 201, {
      "set-cookie": out.cookie,
    });
  });
}

async function createDemo(
  deps: Deps,
  tx: Tx,
  req: Request,
  r: { ip: string; timezone: string; locale: "en" | "hi" },
): Promise<{ cookie: string } | Response> {
  const refusal = await checkDemoCaps(deps, tx, r.ip);
  if (refusal !== null) return capped(deps, req, refusal, r.ip, tx);
  const p = platform(deps.db);
  const expiresAt = new Date(DEMO_WORKSPACE_EXPIRES_AT);
  const ws = await p.workspaces.create(
    {
      kind: "demo",
      locale: r.locale,
      timezone: r.timezone,
      baseCurrency: DEMO_BASE_CURRENCY,
      expiresAt,
      createdIpHash: r.ip,
      llmBudgetUsd: deps.config.llmWorkspaceCapUsd,
    },
    tx,
  );
  const session = await startSession(deps, { workspaceId: ws.id, kind: "demo", userId: null, expiresAt }, tx);
  await p.auth.auditSystem(
    { workspaceId: ws.id, action: "demo.created", detail: { sessionId: session.sessionId, ipHash: r.ip } },
    tx,
  );
  return { cookie: session.cookie };
}
