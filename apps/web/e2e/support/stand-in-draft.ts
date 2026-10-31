// Live judge E2E only (M2-10). TEST STAND-IN for M2-07 (dispute drafting), which isn't built yet: writes
// the draft row and its `provide_evidence` proposal the drafting workflow will write, straight into the
// local database. Nothing here files anything: the spec then approves the proposal through the real M2-08
// API (`POST /api/actions/:id/approve`, the seller's approval bound to the payload hash) and the worker's
// `action.execute` makes the one real PayPal call. The compiled PDF is the scenario's seeded delivery PDF.
import { canonicalHash, WorkspaceIdSchema, type JsonValue } from "@cleared/core";
import { closeDb, createDb, databaseUrl, forWorkspace } from "@cleared/db";

export interface StandInProposal {
  readonly actionId: string;
  readonly payloadSha256: string;
}

export async function standInEvidenceProposal(
  workspaceId: string,
  disputeId: string,
): Promise<StandInProposal> {
  const db = createDb(databaseUrl());
  try {
    const ws = forWorkspace(db, WorkspaceIdSchema.parse(workspaceId));
    const dispute = await ws.disputes.getByDisputeId(disputeId);
    if (dispute === null) throw new Error(`dispute ${disputeId} is not mirrored in workspace ${workspaceId}`);
    const items = await ws.evidenceItems.list();
    const delivery = items.find((i) => i.kind === "delivery" && i.blobId !== null);
    if (delivery?.blobId == null) throw new Error("the scenario's delivery PDF is not in the pack");
    const blob = await ws.blobs.get(delivery.blobId);
    if (blob === null) throw new Error("delivery blob missing");
    const notes =
      "Synthetic sandbox case (judge scenario). The agreed scope was one primary logo in SVG and PNG, black and white variants and a one-page brand guide. All were delivered on 18 October, and the client approved them in writing on 19 October. The brand guide delivered is attached.";
    const draft = await ws.disputeDrafts.insert({
      disputeId: dispute.id,
      notes,
      evidenceItemIds: items.map((i) => i.id),
      compiledBlobId: blob.id,
      sha256: blob.sha256,
    });
    const payload: JsonValue = {
      dispute_id: disputeId,
      evidence_type: "PROOF_OF_FULFILLMENT",
      notes,
      compiled_blob_sha256: blob.sha256,
      draft_id: draft.id,
    };
    const payloadSha256 = canonicalHash(payload);
    const action = await ws.proposedActions.insert({
      kind: "provide_evidence",
      payload,
      payloadSha256,
      state: "proposed",
      risk: "high",
    });
    return { actionId: action.id, payloadSha256 };
  } finally {
    await closeDb(db);
  }
}
