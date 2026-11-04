// BL-01 6595501766 (owner decision 2026-11-03, option a): the dispute draft always carries the client's sign-off
// (M3-06 `client_ack`) and the scope snapshot (M3-07 `scope_snapshot`) when the pack has them, whatever the
// model selected. Code adds them before the compile, so they are inside the compiled PDF whose sha256 is in
// the filing payload the seller approves: nothing is added after approval. PayPal's limits still hold: an
// item of a type PayPal refuses, an item of 10 MB or more, or one that would push the compiled PDF to 10 MB
// is left out, and the draft records why so the approval card can say so (never a silent drop).
import { EVIDENCE_LIMITS } from "@cleared/adapters";
import { AUTO_EVIDENCE_KINDS, type AutoEvidence, type AutoEvidenceKind } from "@cleared/db";

/** jpg/gif/png/pdf files, or pasted text (typeset into the PDF): what the compiled reply can carry. */
const ACCEPTED_MIME = new Set(["image/jpeg", "image/gif", "image/png", "application/pdf"]);

export interface AutoCandidateSource {
  readonly id: string;
  readonly kind: string;
  /** the blob's mime; null for a text-only item */
  readonly mime: string | null;
  /** the blob's size; null for a text-only item */
  readonly size: number | null;
  readonly text: string | null;
}

export interface AutoPlan<T> {
  /** eligible items in pack order; the compile may still leave one out (`pdf_too_large`) */
  readonly candidates: readonly (T & { readonly kind: AutoEvidenceKind })[];
  readonly leftOut: AutoEvidence["leftOut"];
}

export const itemBytes = (i: AutoCandidateSource): number =>
  i.size ?? Buffer.byteLength(i.text ?? "", "utf8");

/**
 * For each auto kind the selection does not already carry, the pack's newest item of that kind, checked
 * against PayPal's per-file limits. `items` is in pack order (oldest first), as the draft's E refs.
 */
export function planAutoEvidence<T extends AutoCandidateSource>(
  items: readonly T[],
  selectedIds: ReadonlySet<string>,
): AutoPlan<T> {
  const candidates: (T & { readonly kind: AutoEvidenceKind })[] = [];
  const leftOut: AutoEvidence["leftOut"][number][] = [];
  for (const kind of AUTO_EVIDENCE_KINDS) {
    const ofKind = items.filter((i) => i.kind === kind);
    if (ofKind.some((i) => selectedIds.has(i.id))) continue; // the selection already carries one
    const newest = ofKind.at(-1);
    if (newest === undefined) continue;
    const bytes = itemBytes(newest);
    if (newest.mime !== null && !ACCEPTED_MIME.has(newest.mime))
      leftOut.push({ id: newest.id, kind, code: "unsupported_type", bytes });
    else if (bytes >= EVIDENCE_LIMITS.maxFileBytes)
      leftOut.push({ id: newest.id, kind, code: "file_too_large", bytes });
    else candidates.push({ ...newest, kind });
  }
  const at = (id: string): number => items.findIndex((i) => i.id === id);
  return { candidates: candidates.sort((a, b) => at(a.id) - at(b.id)), leftOut };
}
