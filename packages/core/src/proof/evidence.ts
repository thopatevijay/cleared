// EvidenceItem: immutable, append-only, content-addressed by sha256 (architecture §2 invariants).
import type { EvidenceItemId, ProofPackId, Sha256, WorkspaceId } from "../ids.ts";
import type { Instant } from "../time.ts";

export const EVIDENCE_KINDS = [
  "scope",
  "delivery",
  "communication",
  "shipment",
  "invoice",
  "scope_snapshot",
  "client_ack",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Readonly by type; there is no update operation. New evidence is a new item (and marks the pack stale). */
export interface EvidenceItem {
  readonly id: EvidenceItemId;
  readonly workspaceId: WorkspaceId;
  readonly packId: ProofPackId;
  readonly kind: EvidenceKind;
  readonly sha256: Sha256;
  readonly mime: string;
  readonly sizeBytes: number;
  /** extracted or typed text; null for an image with no text layer */
  readonly text: string | null;
  readonly createdAt: Instant;
}
