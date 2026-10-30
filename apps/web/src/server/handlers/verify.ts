// GET /api/auth/verify?token=… (M1-05). The link is consumed in the same transaction that creates the
// session; the first verify of a new email also creates the seller's workspace and user.
import { WorkspaceIdSchema } from "@cleared/core";
import { forWorkspace, platform, withTransaction, type Tx } from "@cleared/db";
import type { Deps } from "../deps.ts";
import { DEFAULT_TIMEZONE, localeFrom } from "../locale.ts";
import { apiError, correlationId } from "../respond.ts";
import { isToken, SELLER_SESSION_MS, sha256Hex, startSession } from "../session.ts";

/** A new seller's base currency until onboarding asks (M1-05 default). */
export const NEW_SELLER_BASE_CURRENCY = "USD";

export async function getVerify(req: Request, deps: Deps): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const signedIn = isToken(token) ? await withTransaction(deps.db, (tx) => signIn(deps, tx, token)) : null;
  if (signedIn === null) {
    // A browser following the emailed link gets the expired-link page (M1-07); API clients keep the JSON 400.
    if ((req.headers.get("accept") ?? "").includes("text/html")) {
      const locale = localeFrom(req.headers.get("accept-language"));
      return new Response(null, {
        status: 303,
        headers: {
          location: `${deps.config.appOrigin}/${locale}/signin/expired`,
          "cache-control": "no-store",
        },
      });
    }
    return apiError(
      400,
      "invalid_link",
      "This sign-in link is invalid, used or expired. Request a new one.",
      correlationId(req),
    );
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: `${deps.config.appOrigin}/`,
      "set-cookie": signedIn.cookie,
      "cache-control": "no-store",
    },
  });
}

async function signIn(deps: Deps, tx: Tx, token: string): Promise<{ cookie: string } | null> {
  const p = platform(deps.db);
  const now = deps.now();
  const link = await p.auth.consumeMagicLink(sha256Hex(token), now, tx);
  if (link === null) return null;
  const owner = await ownerOf(deps, tx, link);
  const session = await startSession(
    deps,
    {
      workspaceId: owner.workspaceId,
      kind: "seller",
      userId: owner.userId,
      expiresAt: new Date(now.getTime() + SELLER_SESSION_MS),
    },
    tx,
  );
  await p.auth.auditSystem(
    {
      workspaceId: owner.workspaceId,
      action: "auth.sign_in",
      detail: { userId: owner.userId, sessionId: session.sessionId, newSeller: owner.created },
    },
    tx,
  );
  return { cookie: session.cookie };
}

/** The link's user, or (first verify of a new email) a new seller workspace and user. */
async function ownerOf(
  deps: Deps,
  tx: Tx,
  link: {
    email: string;
    userId: string | null;
    workspaceId: string | null;
    timezone: string | null;
    locale: "en" | "hi" | null;
  },
): Promise<{ workspaceId: string; userId: string; created: boolean }> {
  if (link.userId !== null && link.workspaceId !== null) {
    return { workspaceId: link.workspaceId, userId: link.userId, created: false };
  }
  const p = platform(deps.db);
  const existing = await p.identity.userByEmail(link.email, tx);
  if (existing !== null) return { workspaceId: existing.workspaceId, userId: existing.id, created: false };
  const ws = await p.workspaces.create(
    {
      kind: "seller",
      locale: link.locale ?? "en",
      timezone: link.timezone ?? DEFAULT_TIMEZONE,
      baseCurrency: NEW_SELLER_BASE_CURRENCY,
    },
    tx,
  );
  const user = await forWorkspace(deps.db, WorkspaceIdSchema.parse(ws.id)).users.insert(
    { email: link.email },
    tx,
  );
  return { workspaceId: ws.id, userId: user.id, created: true };
}
