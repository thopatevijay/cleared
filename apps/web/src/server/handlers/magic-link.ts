// POST /api/auth/magic-link (M1-05). Same 200 body whether or not the email has an account, whether or
// not the recipient guard let the mail out, and whether or not the send failed (no enumeration).
import { magicLinkEmail } from "@cleared/adapters";
import { platform } from "@cleared/db";
import { z } from "zod";
import { checkMagicLinkCaps } from "../caps.ts";
import { anonymousScopeId, clientIp, ipHash } from "../client-ip.ts";
import { checkMutation, readJson } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { withIdempotency } from "../idempotency.ts";
import { DEFAULT_TIMEZONE, isSupportedTimeZone, localeFrom } from "../locale.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { newToken, sha256Hex } from "../session.ts";
import { capped } from "./capped.ts";

export const MAGIC_LINK_TTL_MINUTES = 15;
export const MAGIC_LINK_ROUTE = "POST /api/auth/magic-link";

const Body = z.object({ email: z.email().max(254), timezone: z.string().max(64).optional() });

export async function postMagicLink(req: Request, deps: Deps): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const ip = ipHash(clientIp(req.headers), deps.config.sessionSecret);
  const scope = { scopeId: anonymousScopeId(ip), route: MAGIC_LINK_ROUTE, key: check.idempotencyKey };
  return withIdempotency(req, deps, scope, async () => {
    const cid = correlationId(req);
    const parsed = Body.safeParse(await readJson(req));
    if (!parsed.success) return apiError(400, "invalid_email", "Enter a valid email address.", cid);
    const timezone = parsed.data.timezone ?? DEFAULT_TIMEZONE;
    if (!isSupportedTimeZone(timezone)) return apiError(400, "invalid_timezone", "Unknown time zone.", cid);
    const email = parsed.data.email.toLowerCase();
    const refusal = await checkMagicLinkCaps(deps, email, ip);
    if (refusal !== null) return capped(deps, req, refusal, ip);
    await issueLink(deps, { email, ip, timezone, locale: localeFrom(req.headers.get("accept-language")) });
    return json({ ok: true });
  });
}

async function issueLink(
  deps: Deps,
  r: { email: string; ip: string; timezone: string; locale: "en" | "hi" },
): Promise<void> {
  const p = platform(deps.db);
  const user = await p.identity.userByEmail(r.email);
  const token = newToken();
  const expiresAt = new Date(deps.now().getTime() + MAGIC_LINK_TTL_MINUTES * 60_000);
  const link = await p.auth.createMagicLink({
    email: r.email,
    userId: user?.id ?? null,
    workspaceId: user?.workspaceId ?? null,
    tokenHash: sha256Hex(token),
    expiresAt,
    requestedIpHash: r.ip,
    timezone: r.timezone,
    locale: r.locale,
  });
  const url = `${deps.config.appOrigin}/api/auth/verify?token=${token}`;
  const mail = magicLinkEmail(r.locale, { url, minutes: MAGIC_LINK_TTL_MINUTES });
  try {
    const sent = await deps.email.send({ to: r.email, ...mail, idempotencyKey: link.id });
    console.info(JSON.stringify({ service: "auth", msg: "magic link email", linkId: link.id, ...sent }));
  } catch (error) {
    // Logged, never surfaced: the response must not depend on the email outcome.
    const reason = error instanceof Error ? error.name : "unknown";
    console.error(
      JSON.stringify({ service: "auth", msg: "magic link email failed", linkId: link.id, reason }),
    );
  }
}
