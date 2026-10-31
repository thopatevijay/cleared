// BlobStore on Postgres `bytea` (ADR 0002, M2-01). Content-addressed per workspace: the sha256 of the
// bytes is taken here, and identical bytes reuse the existing `blobs` row. An advisory transaction lock
// on (workspace, sha256) makes two concurrent uploads of the same bytes share one row too.
import type { BlobContent, BlobPut, BlobStore, StoredBlob, WorkspaceId } from "@cleared/core";
import { Sha256Schema } from "@cleared/core";
import { evidenceRepo, type Db, type Tx } from "@cleared/db";
import { sha256Of } from "../files/hash.ts";

export function createPostgresBlobStore(db: Db): BlobStore<Tx> {
  return {
    async put(input: BlobPut, tx: Tx): Promise<StoredBlob> {
      const blobs = evidenceRepo(db, input.workspaceId).blobs;
      const sha256 = sha256Of(input.bytes);
      await blobs.lockSha256(sha256, tx);
      const existing = await blobs.findBySha256(sha256, tx);
      if (existing !== null) {
        return { id: existing.id, sha256, mime: existing.mime, size: existing.size, reused: true };
      }
      const row = await blobs.insert(
        { mime: input.mime, bytes: Buffer.from(input.bytes), size: input.bytes.byteLength, sha256 },
        tx,
      );
      return { id: row.id, sha256, mime: row.mime, size: row.size, reused: false };
    },

    async get(workspaceId: WorkspaceId, id: string, tx?: Tx): Promise<BlobContent | null> {
      const row = await evidenceRepo(db, workspaceId).blobs.get(id, tx);
      if (row === null) return null;
      return {
        id: row.id,
        sha256: Sha256Schema.parse(row.sha256),
        mime: row.mime,
        size: row.size,
        bytes: new Uint8Array(row.bytes),
      };
    },
  };
}
