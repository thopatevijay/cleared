// POST /api/disputes/:id/draft/revise (M2-09): the seller edits the notes or the evidence selection. No
// model call: validation, a fresh compile of the selected items, a new seller-created proposal and the
// draft row updated in place, in one transaction under the dispute's lock. The superseded proposal goes
// `proposed → rejected` (audit `action.rejected`, reason `superseded`), so only the new hash can be
// approved. A draft whose filing already failed can be re-proposed the same way (BL-01 6537331741).
import { compileEvidencePdf, createPostgresBlobStore, type CompileItem } from "@cleared/adapters/files";
import { checkProposal, type JsonValue, type WorkspaceId } from "@cleared/core";
import {
  appendActionAudit,
  disputeDraftsRepo,
  evidenceRepo,
  forWorkspace,
  getProposedAction,
  insertSellerProposal,
  setProposedActionState,
  withTransaction,
  type DisputeDraftRow,
  type DisputeRow,
  type ProposedActionRow,
  type Tx,
} from "@cleared/db";
import { z } from "zod";
import { codePointCount, NOTES_MAX } from "../../lib/dispute-view.ts";
import type { Deps } from "../deps.ts";

export const ReviseBodySchema = z.strictObject({
  draft_id: z.uuid(),
  notes: z.string().max(NOTES_MAX * 2),
  evidence_item_ids: z.array(z.uuid()).min(1).max(20),
});
export type ReviseBody = z.infer<typeof ReviseBodySchema>;

export type ReviseResult =
  | { readonly ok: true; readonly action: ProposedActionRow }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly details?: JsonValue };

const fail = (status: number, code: string, details?: JsonValue): ReviseResult =>
  details === undefined ? { ok: false, status, code } : { ok: false, status, code, details };

/** Blocks a revision of a filing the seller already approved (it may be on its way to PayPal). */
const IN_FLIGHT = new Set(["approved", "executing", "unknown", "succeeded"]);

export function checkNotes(notes: string): ReviseResult | null {
  if (notes.trim() === "") return fail(422, "NOTES_EMPTY");
  if (codePointCount(notes) > NOTES_MAX) return fail(422, "NOTES_TOO_LONG");
  return null;
}

/** The new selection in PDF order: the draft's own order first, then newly ticked items in pack order. */
export function orderSelection(
  previous: readonly string[],
  packOrder: readonly string[],
  chosen: readonly string[],
) {
  const want = new Set(chosen);
  const kept = previous.filter((id) => want.has(id));
  return [...kept, ...packOrder.filter((id) => want.has(id) && !kept.includes(id))];
}

type PackItem = Awaited<ReturnType<ReturnType<typeof evidenceRepo>["items"]["listForPack"]>>[number];

async function compile(
  deps: Deps,
  ws: WorkspaceId,
  dispute: DisputeRow,
  draft: DisputeDraftRow,
  items: readonly PackItem[],
  ids: readonly string[],
  tx: Tx,
) {
  const blobs = createPostgresBlobStore(deps.db);
  const selected: CompileItem[] = [];
  for (const id of ids) {
    const n = items.findIndex((i) => i.id === id);
    const item = items[n];
    if (item === undefined) continue;
    const blob = item.blobId === null ? null : await blobs.get(ws, item.blobId, tx);
    selected.push({
      id: item.id,
      ref: `E${String(n + 1)}`,
      kind: item.kind,
      sha256: item.sha256,
      addedAt: item.createdAt.toISOString(),
      mime: blob?.mime ?? null,
      bytes: blob ? new Uint8Array(blob.bytes) : null,
      text: item.text,
    });
  }
  const pay =
    dispute.paymentId === null ? null : await forWorkspace(deps.db, ws).payments.get(dispute.paymentId, tx);
  const amount =
    dispute.amount !== null && dispute.currency !== null
      ? { value: dispute.amount, currency_code: dispute.currency.trim() }
      : null;
  return compileEvidencePdf(
    {
      disputeId: dispute.disputeId,
      captureId: pay?.captureId ?? null,
      amount,
      reason: dispute.reason,
      evidenceType: draft.evidenceType ?? "OTHER",
      compiledAt: deps.now().toISOString(),
    },
    selected,
  );
}

function filingPayload(
  kind: string,
  p: { disputeId: string; evidenceType: string | null; notes: string; sha: string; draftId: string },
): JsonValue {
  const common = {
    dispute_id: p.disputeId,
    notes: p.notes,
    compiled_blob_sha256: p.sha,
    draft_id: p.draftId,
  };
  return kind === "provide_evidence" ? { ...common, evidence_type: p.evidenceType ?? "OTHER" } : common;
}

/** fact refs that still point at a selected item (scope lines keep theirs) */
function keptFactRefs(factRefs: unknown, ids: readonly string[]): JsonValue {
  const Refs = z
    .array(
      z.object({
        paragraph: z.number(),
        refs: z.array(
          z.object({ ref: z.string(), kind: z.string(), evidence_item_id: z.string().nullable() }),
        ),
      }),
    )
    .catch([]);
  return Refs.parse(factRefs).map((f) => ({
    paragraph: f.paragraph,
    refs: f.refs.filter((r) => r.evidence_item_id === null || ids.includes(r.evidence_item_id)),
  }));
}

interface ReviseInput {
  readonly ws: WorkspaceId;
  readonly dispute: DisputeRow;
  readonly body: ReviseBody;
  readonly actor: string;
}

export function reviseDraft(deps: Deps, r: ReviseInput): Promise<ReviseResult> {
  const notesProblem = checkNotes(r.body.notes);
  if (notesProblem !== null) return Promise.resolve(notesProblem);
  return withTransaction(deps.db, async (tx) => {
    const drafts = disputeDraftsRepo(deps.db, r.ws);
    await drafts.lockDispute(r.dispute.id, tx);
    const draft = (await drafts.listForDispute(r.dispute.id, tx)).find((d) => d.id === r.body.draft_id);
    if (draft === undefined) return fail(404, "NOT_FOUND");
    const kind = draft.actionKind;
    if ((kind !== "provide_evidence" && kind !== "provide_supporting_info") || draft.packId === null)
      return fail(409, "DRAFT_NOT_REVISABLE");
    const old =
      draft.proposedActionId === null
        ? null
        : await getProposedAction(deps.db, r.ws, draft.proposedActionId, { tx, lock: true });
    if (old !== null && IN_FLIGHT.has(old.state)) return fail(409, "ACTION_NOT_PROPOSED");
    if (!z.array(z.string()).catch([]).parse(r.dispute.allowedActions).includes(kind))
      return fail(409, "ACTION_LINK_MISSING");
    if (r.dispute.deadlineState === "closed_for_action") return fail(409, "DEADLINE_PASSED");
    const items = (await evidenceRepo(deps.db, r.ws).items.listForPack(draft.packId, tx)).reverse();
    const unknown = r.body.evidence_item_ids.filter((id) => !items.some((i) => i.id === id));
    if (unknown.length > 0) return fail(422, "UNKNOWN_EVIDENCE_ITEM", { ids: unknown });
    const ids = orderSelection(
      draft.evidenceItemIds,
      items.map((i) => i.id),
      r.body.evidence_item_ids,
    );
    const pdf = await compile(deps, r.ws, r.dispute, draft, items, ids, tx);
    if (!pdf.ok) return fail(422, pdf.error.code.toUpperCase(), pdf.error as unknown as JsonValue);
    return persist(deps, tx, { ...r, draft, kind, old, ids, pdf: pdf.value });
  });
}

interface Persist extends ReviseInput {
  readonly draft: DisputeDraftRow;
  readonly kind: "provide_evidence" | "provide_supporting_info";
  readonly old: ProposedActionRow | null;
  readonly ids: readonly string[];
  readonly pdf: { readonly bytes: Uint8Array; readonly sha256: string };
}

async function persist(deps: Deps, tx: Tx, p: Persist): Promise<ReviseResult> {
  await evidenceRepo(deps.db, p.ws).lockWorkspace(tx); // M2-01: the workspace lock before any blob lock
  const blob = await createPostgresBlobStore(deps.db).put(
    { workspaceId: p.ws, bytes: p.pdf.bytes, mime: "application/pdf" },
    tx,
  );
  const payload = filingPayload(p.kind, {
    disputeId: p.dispute.disputeId,
    evidenceType: p.draft.evidenceType,
    notes: p.body.notes,
    sha: p.pdf.sha256,
    draftId: p.draft.id,
  });
  const checked = checkProposal(p.kind, payload);
  if (!checked.ok) return fail(422, "INVALID_PAYLOAD");
  const detail = p.old === null ? {} : { revisionOf: p.old.id };
  const action = await insertSellerProposal(
    deps.db,
    { workspaceId: p.ws, proposedBy: p.actor, kind: p.kind, payload, detail },
    tx,
  );
  if (p.old !== null && p.old.state === "proposed") {
    await setProposedActionState(deps.db, p.ws, p.old.id, { from: "proposed", to: "rejected" }, tx);
    await appendActionAudit(
      deps.db,
      {
        workspaceId: p.ws,
        actionId: p.old.id,
        actor: "seller",
        action: "action.rejected",
        detail: { reason: "superseded", supersededBy: action.id, rejectedBy: p.actor },
      },
      tx,
    );
  }
  await disputeDraftsRepo(deps.db, p.ws).revise(
    p.draft.id,
    {
      notes: p.body.notes,
      evidenceItemIds: p.ids,
      factRefs: keptFactRefs(p.draft.factRefs, p.ids),
      compiledBlobId: blob.id,
      sha256: action.payloadSha256,
      proposedActionId: action.id,
    },
    tx,
  );
  return { ok: true, action };
}
