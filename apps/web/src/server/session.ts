// Sessions (ADR 0007, M1-05): an opaque 32-byte random token in `__Host-cleared_session`; only its
// sha256 is stored. Seller sessions last 30 days and slide on use; demo sessions end with the workspace.
// The workspace id comes ONLY from the session row, never from the client.
import { createHash, randomBytes } from "node:crypto";
import { platform, type Executor } from "@cleared/db";
import type { Deps } from "./deps.ts";
import { apiError, correlationId } from "./respond.ts";

import { SESSION_COOKIE } from "../lib/session-cookie.ts";

export { SESSION_COOKIE };
export const SELLER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** A seller session's expiry moves at most this often (one write per active 5 minutes). */
export const RENEW_AFTER_MS = 5 * 60 * 1000;

export type SessionKind = "seller" | "demo";

export interface Session {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly kind: SessionKind;
  readonly userId?: string;
  /** Set when sliding renewal moved the expiry: send it back so the browser's cookie moves too. */
  readonly renewedCookie?: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32 random bytes as base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isToken(raw: string): boolean {
  return TOKEN_RE.test(raw);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * `Set-Cookie` for a session. Always `Secure`: the `__Host-` prefix requires it, and browsers accept a
 * Secure cookie on http://localhost, so development works too.
 */
export function sessionCookie(token: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return isToken(value) ? value : null;
    }
  }
  return null;
}

/** Inserts a session and returns its id plus the cookie that carries it. */
export async function startSession(
  deps: Deps,
  s: { workspaceId: string; kind: SessionKind; userId: string | null; expiresAt: Date },
  tx?: Executor,
): Promise<{ sessionId: string; cookie: string }> {
  const token = newToken();
  const now = deps.now();
  const row = await platform(deps.db).auth.createSession(
    {
      workspaceId: s.workspaceId,
      userId: s.userId,
      kind: s.kind,
      tokenHash: sha256Hex(token),
      expiresAt: s.expiresAt,
      lastSeenAt: now,
    },
    tx,
  );
  return { sessionId: row.id, cookie: sessionCookie(token, s.expiresAt, now) };
}

/** The caller's session, or null (no cookie, unknown token, expired). */
export async function getSession(req: Request, deps: Deps): Promise<Session | null> {
  const token = readSessionToken(req);
  if (token === null) return null;
  const p = platform(deps.db);
  const row = await p.identity.sessionByTokenHash(sha256Hex(token));
  const now = deps.now();
  if (row === null || row.expiresAt.getTime() <= now.getTime()) return null;
  const base: Session = {
    sessionId: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    ...(row.userId === null ? {} : { userId: row.userId }),
  };
  const lastSeen = row.lastSeenAt?.getTime() ?? 0;
  if (row.kind !== "seller" || now.getTime() - lastSeen < RENEW_AFTER_MS) return base;
  const expiresAt = new Date(now.getTime() + SELLER_SESSION_MS);
  await p.auth.touchSession(row.id, row.workspaceId, now, expiresAt);
  return { ...base, renewedCookie: sessionCookie(token, expiresAt, now) };
}

/** For every non-public route: the session, or a 401 in the ADR 0003 envelope. */
export async function requireSession(req: Request, deps: Deps): Promise<Session | Response> {
  const session = await getSession(req, deps);
  if (session !== null) return session;
  return apiError(401, "unauthenticated", "Sign in or start a demo to continue.", correlationId(req));
}

/** Adds the renewed cookie (if any) to a response. */
export function withRenewal(res: Response, session: Session): Response {
  if (session.renewedCookie !== undefined) res.headers.append("set-cookie", session.renewedCookie);
  return res;
}
