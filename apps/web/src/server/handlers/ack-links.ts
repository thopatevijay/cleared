// Seller side of the client acknowledgement link (M3-06): read the pack's link, create one for the pack's
// current scope item, revoke it. Every route acts on the session's workspace only (a foreign pack is a 404).
// The raw token leaves the server once, in the 201 body of the create call, and is never stored: only its
// sha256 is. That is also why create does not go through the idempotency store (it keeps response
// bodies); a retried create meets the "one active link" rule instead and gets a 409.
import { randomBytes } from "node:crypto";
import {
  ACK_TOKEN_BYTES,
  ackLinkExpiry,
  ackLinkStatus,
  ackTokenHash,
  type AckLinkView,
  type WorkspaceId,
} from "@cleared/core";
import {
  clientAcksRepo,
  evidenceRepo,
  forWorkspace,
  platform,
  withTransaction,
  type ClientAckRow,
  type ClientAcksRepo,
} from "@cleared/db";
import { checkMutation } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal, type Session } from "../session.ts";

const notFound = (req: Request): Response =>
  apiError(404, "not_found", "Proof pack not found.", correlationId(req));

export function ackLinkView(
  link: ClientAckRow | null,
  scope: { readonly id: string; readonly sha256: string } | null,
  workspaceExpiresAt: Date | null,
  now: Date,
): AckLinkView {
  if (link === null) return { scopeItemId: scope?.id ?? null, link: null };
  const status = ackLinkStatus(link, scope?.sha256 ?? null, now);
  return {
    scopeItemId: scope?.id ?? null,
    link: {
      id: link.id,
      status,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt.toISOString(),
      expiryCapped: workspaceExpiresAt !== null && link.expiresAt.getTime() === workspaceExpiresAt.getTime(),
      acceptedAt: link.acceptedAt?.toISOString() ?? null,
      revokedAt: link.revokedAt?.toISOString() ?? null,
      earlierScope: status === "accepted" && link.scopeSha256 !== scope?.sha256,
      evidenceItemId: link.evidenceItemId,
    },
  };
}

async function viewFor(deps: Deps, repo: ClientAcksRepo, ws: string, packId: string): Promise<AckLinkView> {
  const [scope, link, workspace] = await Promise.all([
    repo.currentScopeItem(packId),
    repo.latestForPack(packId),
    platform(deps.db).workspaces.get(ws),
  ]);
  return ackLinkView(link, scope, workspace?.expiresAt ?? null, deps.now());
}

async function ownedPack(req: Request, deps: Deps, packId: string): Promise<Session | Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const owned = await evidenceRepo(deps.db, session.workspaceId as WorkspaceId).packs.getOwned(packId);
  return owned === null ? notFound(req) : session;
}

/** GET /api/packs/:packId/ack-links: the pack's newest link and its status. */
export async function getAckLinks(req: Request, deps: Deps, packId: string): Promise<Response> {
  const session = await ownedPack(req, deps, packId);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  return withRenewal(json(await viewFor(deps, clientAcksRepo(deps.db, ws), ws, packId)), session);
}

type CreateOutcome = { readonly token: string } | { readonly refused: "ack_no_scope" | "ack_link_active" };

async function createLink(deps: Deps, ws: WorkspaceId, packId: string): Promise<CreateOutcome | null> {
  const repo = clientAcksRepo(deps.db, ws);
  return withTransaction(deps.db, async (tx) => {
    // The pack row lock serialises creates on one pack, so "one active link per scope item" holds.
    const pack = await evidenceRepo(deps.db, ws).packs.lock(packId, tx);
    if (pack === null) return null;
    const scope = await repo.currentScopeItem(pack.id, tx);
    if (scope === null) return { refused: "ack_no_scope" };
    const now = deps.now();
    const open = await repo.openForScopeItem(scope.id, tx);
    if (open.some((l) => ackLinkStatus(l, scope.sha256, now) === "pending"))
      return { refused: "ack_link_active" };
    const workspace = await platform(deps.db).workspaces.get(ws, tx);
    const token = randomBytes(ACK_TOKEN_BYTES).toString("base64url");
    const link = await repo.insert(
      {
        packId: pack.id,
        tokenHash: ackTokenHash(token),
        scopeItemId: scope.id,
        scopeSha256: scope.sha256,
        expiresAt: ackLinkExpiry(now, workspace?.expiresAt ?? null),
      },
      tx,
    );
    await forWorkspace(deps.db, ws).auditLog.insert(
      {
        actor: "seller",
        action: "ack_link.created",
        detail: {
          ackId: link.id,
          packId: pack.id,
          scopeSha256: scope.sha256,
          expiresAt: link.expiresAt.toISOString(),
        },
      },
      tx,
    );
    return { token };
  });
}

const REFUSALS = {
  ack_no_scope: "Add the agreed scope to this pack first.",
  ack_link_active: "This scope already has an active link. Revoke it to create a new one.",
} as const;

/** POST /api/packs/:packId/ack-links → 201 `{ url, view }`; the URL carries the raw token this once. */
export async function postAckLink(req: Request, deps: Deps, packId: string): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await ownedPack(req, deps, packId);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const out = await createLink(deps, ws, packId);
  if (out === null) return notFound(req);
  if ("refused" in out) return apiError(409, out.refused, REFUSALS[out.refused], correlationId(req));
  const url = `${deps.config.appOrigin}/ack/${out.token}`;
  const view = await viewFor(deps, clientAcksRepo(deps.db, ws), ws, packId);
  return withRenewal(json({ url, view }, 201), session);
}

/** POST /api/packs/:packId/ack-links/:linkId/revoke → 200 view; 409 when the link is already final. */
export async function postAckRevoke(
  req: Request,
  deps: Deps,
  packId: string,
  linkId: string,
): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await ownedPack(req, deps, packId);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const repo = clientAcksRepo(deps.db, ws);
  const revoked = await withTransaction(deps.db, async (tx) => {
    const row = await repo.revoke(packId, linkId, deps.now(), tx);
    if (row === null) return null;
    await forWorkspace(deps.db, ws).auditLog.insert(
      { actor: "seller", action: "ack_link.revoked", detail: { ackId: row.id, packId: row.packId } },
      tx,
    );
    return row;
  });
  if (revoked === null) {
    const exists = await repo.get(linkId);
    return exists === null || exists.packId !== packId
      ? apiError(404, "not_found", "Link not found.", correlationId(req))
      : apiError(409, "ack_link_final", "This link was already accepted or revoked.", correlationId(req));
  }
  return withRenewal(json(await viewFor(deps, repo, ws, packId)), session);
}
