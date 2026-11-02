// M3-01 holds API (hold.md). Both routes act on the session's workspace only:
//   GET /api/holds       active holds + the held total per currency (derived holds only)
//   GET /api/holds/:id   one hold (any state) with its mirrored capture; 404 when foreign or unowned
import type { WorkspaceId } from "@cleared/core";
import type { Deps } from "../deps.ts";
import { holdDetail, listHolds } from "../holds/read.ts";
import { json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";
import { refusal } from "./actions.ts";

export async function getHolds(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  return withRenewal(json(await listHolds(deps, session.workspaceId as WorkspaceId)), session);
}

export async function getHold(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const detail = await holdDetail(deps, session.workspaceId as WorkspaceId, rawId);
  if (detail === null) return refusal(req, 404, "NOT_FOUND", "No such hold in this workspace.");
  return withRenewal(json(detail), session);
}
