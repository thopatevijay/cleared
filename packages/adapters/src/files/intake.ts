// The evidence write (M2-01; moved here from apps/web in M2-10 so the worker's scenario seed uses the same
// path): one transaction holds the blob, the evidence row, the pack's new state and
// the outbox `evidence.added` event (ADR 0004), so either all of them exist or none does. Writes are
// serialised per workspace, which makes the 50-per-pack and 200 MB-per-workspace checks race-free.
import {
  checkEvidenceCapacity,
  err,
  EvidenceAddedEvent,
  ok,
  packStateAfterEvidence,
  type BlobStore,
  type EvidenceRejection,
  type Result,
  type SellerEvidenceKind,
  type Sha256,
  type WorkspaceId,
} from "@cleared/core";
import type { PreparedFile } from "./prepare.ts";
import {
  evidenceRepo,
  withTransaction,
  type Db,
  type EvidenceItemRow,
  type Publisher,
  type Tx,
} from "@cleared/db";

export interface IntakeDeps {
  readonly db: Db;
  readonly blobs: BlobStore<Tx>;
  readonly publisher: Pick<Publisher, "emit">;
  readonly now: () => Date;
}

export type NewEvidence =
  | { readonly type: "file"; readonly kind: SellerEvidenceKind; readonly file: PreparedFile }
  | {
      readonly type: "file";
      /** written by Cleared's own job (M3-07), keyed on its input hash; never from a seller's request */
      readonly kind: "scope_snapshot";
      readonly file: Pick<PreparedFile, "mime" | "bytes" | "size" | "sha256" | "text">;
      readonly inputSha256: Sha256;
    }
  | {
      readonly type: "text";
      /**
       * `client_ack` is written by Cleared itself (M3-06, the buyer's acceptance), never from a seller's
       * request: the intake routes parse the kind with `SellerEvidenceKindSchema`.
       */
      readonly kind: SellerEvidenceKind | "client_ack";
      readonly text: string;
      readonly sha256: Sha256;
    };

export type IntakeFailure = EvidenceRejection | { readonly code: "PACK_NOT_FOUND" };

/** Thrown inside the transaction to roll it back with a typed refusal. */
export class EvidenceRefusedError extends Error {
  readonly failure: IntakeFailure;
  constructor(failure: IntakeFailure) {
    super(failure.code);
    this.failure = failure;
  }
}

/** The write inside the caller's transaction (M2-10 seed step); throws `EvidenceRefusedError` on a refusal. */
export async function writeEvidence(
  d: IntakeDeps,
  tx: Tx,
  workspaceId: WorkspaceId,
  packId: string,
  input: NewEvidence,
): Promise<EvidenceItemRow> {
  const repo = evidenceRepo(d.db, workspaceId);
  await repo.lockWorkspace(tx);
  // The pack must be ours and its payment too (ownership); a foreign pack is indistinguishable from none.
  const owned = await repo.packs.getOwned(packId, tx);
  const pack = owned === null ? null : await repo.packs.lock(owned.id, tx);
  if (pack === null) throw new EvidenceRefusedError({ code: "PACK_NOT_FOUND" });

  const [itemsInPack, workspaceBytes] = await Promise.all([
    repo.items.countForPack(pack.id, tx),
    repo.items.usageBytes(tx),
  ]);
  const blob =
    input.type === "file"
      ? await d.blobs.put({ workspaceId, bytes: input.file.bytes, mime: input.file.mime }, tx)
      : null;
  const addBytes =
    input.type === "text" ? Buffer.byteLength(input.text, "utf8") : blob?.reused ? 0 : input.file.size;
  const capacity = checkEvidenceCapacity({ itemsInPack, workspaceBytes, addBytes });
  if (!capacity.ok) throw new EvidenceRefusedError(capacity.error);

  const item = await repo.items.insert(
    {
      packId: pack.id,
      kind: input.kind,
      blobId: blob?.id ?? null,
      sha256: input.type === "file" ? input.file.sha256 : input.sha256,
      text: input.type === "file" ? input.file.text : input.text,
      inputSha256: "inputSha256" in input ? input.inputSha256 : null,
    },
    tx,
  );
  const next = packStateAfterEvidence(pack.state);
  if (next !== pack.state) await repo.packs.setState(pack.id, next, tx);
  const event = EvidenceAddedEvent.parse({
    type: "evidence.added",
    version: 1,
    workspaceId,
    occurredAt: d.now().toISOString(),
    data: { packId: pack.id, evidenceItemId: item.id, kind: item.kind, sha256: item.sha256 },
  });
  await d.publisher.emit(tx, event);
  return item;
}

export async function addEvidence(
  d: IntakeDeps,
  workspaceId: WorkspaceId,
  packId: string,
  input: NewEvidence,
): Promise<Result<EvidenceItemRow, IntakeFailure>> {
  try {
    return ok(await withTransaction(d.db, (tx) => writeEvidence(d, tx, workspaceId, packId, input)));
  } catch (error) {
    if (error instanceof EvidenceRefusedError) return err(error.failure);
    throw error;
  }
}
