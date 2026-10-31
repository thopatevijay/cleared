// M2-09 dispute API (dispute-review.md). Every route acts on the session's workspace only.
//   GET  /api/disputes                      list + "in dispute" totals per currency
//   GET  /api/disputes/:id                  mirror + linked payment/hold + current draft + proposals + audit
//   POST /api/disputes/:id/draft/revise     {draft_id, notes, evidence_item_ids} → a new proposal (no model)
//   GET  /api/disputes/:id/draft/pdf?draft  the draft's compiled evidence PDF
// `:id` is our `disputes.id` (or PayPal's dispute id on the reads). Approval stays M2-08's
// `POST /api/actions/:id/approve`, bound to the payload sha256 the seller reviewed.
import { createPostgresBlobStore } from "@cleared/adapters/files";
import type { WorkspaceId } from "@cleared/core";
import { disputeDraftsRepo } from "@cleared/db";
import { z } from "zod";
import type { Deps } from "../deps.ts";
import { disputeDetail, findDispute, listDisputes } from "../disputes/read.ts";
import { reviseDraft, ReviseBodySchema } from "../disputes/revise.ts";
import { withIdempotency } from "../idempotency.ts";
import { apiError, correlationId, json } from "../respond.ts";
import { requireSession, withRenewal } from "../session.ts";
import { actorOf, mutation, refusal, view } from "./actions.ts";

const REVISE_MESSAGE: Readonly<Record<string, string>> = {
  NOT_FOUND: "No such draft on this dispute.",
  NOTES_EMPTY: "The reply can't be empty.",
  NOTES_TOO_LONG: "PayPal accepts at most 2000 characters.",
  DRAFT_NOT_REVISABLE: "This draft can't be edited here.",
  ACTION_NOT_PROPOSED: "This reply was already approved, so it can't change now.",
  ACTION_LINK_MISSING: "PayPal no longer allows this reply on this dispute.",
  DEADLINE_PASSED: "Too late to reply here.",
  UNKNOWN_EVIDENCE_ITEM: "An evidence item is not in this dispute's proof pack.",
  PDF_TOO_LARGE: "The evidence PDF would be 10 MB or more. Deselect a large item.",
  INVALID_PAYLOAD: "This reply is not valid.",
};

export async function getDisputes(req: Request, deps: Deps): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  return withRenewal(json(await listDisputes(deps, session.workspaceId)), session);
}

export async function getDispute(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const detail = await disputeDetail(deps, session.workspaceId, rawId);
  if (detail === null) return refusal(req, 404, "NOT_FOUND", "No such dispute in this workspace.");
  return withRenewal(json(detail), session);
}

export async function postRevise(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const m = await mutation(req, deps, ReviseBodySchema);
  if (m instanceof Response) return m;
  const ws = m.session.workspaceId as WorkspaceId;
  const dispute = z.uuid().safeParse(rawId).success ? await findDispute(deps, ws, rawId) : null;
  if (dispute === null) return refusal(req, 404, "NOT_FOUND", "No such dispute in this workspace.");
  const scope = {
    scopeId: m.session.sessionId,
    route: `POST /api/disputes/${dispute.id}/draft/revise`,
    key: m.key,
  };
  return withIdempotency(req, deps, scope, async () => {
    const r = await reviseDraft(deps, { ws, dispute, body: m.body, actor: actorOf(m.session) });
    if (!r.ok)
      return refusal(req, r.status, r.code, REVISE_MESSAGE[r.code] ?? "This draft can't be revised.");
    return withRenewal(json({ action: await view(deps, r.action) }), m.session);
  });
}

export async function getDraftPdf(req: Request, deps: Deps, rawId: string): Promise<Response> {
  const session = await requireSession(req, deps);
  if (session instanceof Response) return session;
  const ws = session.workspaceId as WorkspaceId;
  const draftId = new URL(req.url).searchParams.get("draft") ?? "";
  const dispute = await findDispute(deps, ws, rawId);
  const draft =
    dispute === null || !z.uuid().safeParse(draftId).success
      ? undefined
      : (await disputeDraftsRepo(deps.db, ws).listForDispute(dispute.id)).find((d) => d.id === draftId);
  const blob =
    draft?.compiledBlobId == null
      ? null
      : await createPostgresBlobStore(deps.db).get(ws, draft.compiledBlobId);
  if (dispute === null || blob === null) {
    return apiError(404, "not_found", "No compiled evidence for this draft.", correlationId(req));
  }
  const res = new Response(new Uint8Array(blob.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(blob.size),
      "content-disposition": `attachment; filename="evidence-${dispute.disputeId}.pdf"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      etag: `"${blob.sha256}"`,
    },
  });
  return withRenewal(res, session);
}
