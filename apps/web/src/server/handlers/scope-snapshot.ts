// The pack's scope snapshot (M3-07, ADR 0018). GET downloads the newest `scope_snapshot` PDF as an attachment;
// POST asks the worker to render one (`scope_snapshot.render`). Both act on the session's workspace only: a
// foreign or unknown pack is a 404, exactly like a pack without a snapshot yet.
import { createPostgresBlobStore } from "@cleared/adapters/files";
import type { WorkspaceId } from "@cleared/core";
import {
  clientAcksRepo,
  evidenceRepo,
  SCOPE_SNAPSHOT_RENDER_QUEUE,
  withTransaction,
  type Publisher,
} from "@cleared/db";
import { checkMutation } from "../csrf.ts";
import type { Deps } from "../deps.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";
import { attachment } from "./evidence.ts";

const notFound = (req: Request, what: "pack" | "snapshot"): Response =>
  apiError(
    404,
    "not_found",
    what === "pack" ? "Proof pack not found." : "This pack has no scope snapshot yet.",
    correlationId(req),
  );

/** GET /api/packs/:packId/scope-snapshot: the newest snapshot, always as a download. */
export async function getScopeSnapshot(req: Request, deps: Deps, packId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const repo = evidenceRepo(deps.db, ws);
  const pack = await repo.packs.getOwned(packId);
  if (pack === null) return notFound(req, "pack");
  const item = (await repo.items.listForPack(pack.id)).find((i) => i.kind === "scope_snapshot");
  const blob = item?.blobId ? await createPostgresBlobStore(deps.db).get(ws, item.blobId) : null;
  if (!item || blob === null) return notFound(req, "snapshot");
  return withRenewal(attachment(blob, `scope-snapshot-${item.sha256.slice(0, 12)}.pdf`), session);
}

/** POST /api/packs/:packId/scope-snapshot: 202 queued; 409 `snapshot_no_scope` before any scope item. */
export async function postScopeSnapshot(
  req: Request,
  deps: Deps,
  packId: string,
  publisher: () => Promise<Publisher>,
): Promise<Response> {
  const check = checkMutation(req, deps.config.appOrigin);
  if (!check.ok) return check.response;
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const pub = await publisher();
  const out = await withTransaction(deps.db, async (tx) => {
    const pack = await evidenceRepo(deps.db, ws).packs.getOwned(packId, tx);
    if (pack === null) return "not_found" as const;
    if ((await clientAcksRepo(deps.db, ws).currentScopeItem(pack.id, tx)) === null)
      return "no_scope" as const;
    // one queued render per (pack, request key): a retried click is a no-op; the job is idempotent anyway
    await pub.enqueue(
      tx,
      SCOPE_SNAPSHOT_RENDER_QUEUE,
      { workspaceId: ws, packId: pack.id },
      { workspaceId: ws, singletonKey: `${pack.id}:${check.idempotencyKey}` },
    );
    return "queued" as const;
  });
  if (out === "not_found") return notFound(req, "pack");
  if (out === "no_scope")
    return apiError(409, "snapshot_no_scope", "Add the agreed scope to this pack first.", correlationId(req));
  return withRenewal(json({ status: "queued" }, 202), session);
}
