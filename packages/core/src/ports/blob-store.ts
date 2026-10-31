// BlobStore port (ADR 0002): content-addressed, immutable bytes. The Postgres `bytea` implementation is in
// packages/adapters; an S3 one can replace it above 5 GB without touching callers.
import type { Sha256, WorkspaceId } from "../ids.ts";
import type { EvidenceMime } from "../proof/evidence.ts";

export interface BlobPut {
  readonly workspaceId: WorkspaceId;
  /** the bytes to store, already sniffed, capped and re-encoded */
  readonly bytes: Uint8Array;
  readonly mime: EvidenceMime;
}

export interface StoredBlob {
  readonly id: string;
  readonly sha256: Sha256;
  readonly mime: string;
  readonly size: number;
  /** true when identical bytes were already stored in this workspace and that row was reused */
  readonly reused: boolean;
}

export interface BlobContent extends Omit<StoredBlob, "reused"> {
  readonly bytes: Uint8Array;
}

/**
 * `Tx` is the caller's transaction handle, so a blob commits or rolls back with the evidence row that
 * points at it. Blobs are never updated or deleted through this port (retention is M4-07's purge).
 */
export interface BlobStore<Tx> {
  /** Stores the bytes once per workspace: identical bytes return the existing blob (`reused: true`). */
  put(input: BlobPut, tx: Tx): Promise<StoredBlob>;
  /** `null` when the blob does not exist or belongs to another workspace. */
  get(workspaceId: WorkspaceId, id: string, tx?: Tx): Promise<BlobContent | null>;
}
