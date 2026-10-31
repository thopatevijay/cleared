// The evidence intake contract (ADR 0003, M2-01):
//   POST /api/packs/:packId/evidence/upload   multipart: `kind` + one `file`
//   POST /api/packs/:packId/evidence/text     JSON: { kind, text }
//   GET  /api/packs/:packId/evidence          → EvidenceListResponse (newest first)
//   GET  /api/evidence/:id/file               → the stored bytes (attachment, nosniff)
import { z } from "zod";
import { EVIDENCE_KINDS, SellerEvidenceKindSchema } from "../proof/evidence.ts";

/** Characters of a text item returned in the list; the full text stays server-side (M2-03/M2-04 read it). */
export const EVIDENCE_EXCERPT_CHARS = 280;
/** Upper bound on a text request body (50,000 characters JSON-escaped fit well inside it). */
export const EVIDENCE_TEXT_BODY_MAX_BYTES = 1_000_000;
/** Multipart overhead allowed on top of the 10 MB file cap before the body is refused unread. */
export const EVIDENCE_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export const EvidenceTextRequestSchema = z.object({
  kind: SellerEvidenceKindSchema,
  text: z.string(),
});
export type EvidenceTextRequest = z.infer<typeof EvidenceTextRequestSchema>;

export const EvidenceItemResponseSchema = z.object({
  id: z.uuid(),
  packId: z.uuid(),
  kind: z.enum(EVIDENCE_KINDS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** stored (re-encoded) file's type and size; null for a text item */
  mime: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  /** `/api/evidence/:id/file` for a file item; null for a text item */
  fileUrl: z.string().nullable(),
  hasText: z.boolean(),
  textLength: z.number().int().nonnegative(),
  /** first 280 characters of the text (pasted, or a PDF's text layer); render as plain text */
  excerpt: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type EvidenceItemResponse = z.infer<typeof EvidenceItemResponseSchema>;

export const EvidenceAddedResponseSchema = z.object({ item: EvidenceItemResponseSchema });
export type EvidenceAddedResponse = z.infer<typeof EvidenceAddedResponseSchema>;

export const EvidenceListResponseSchema = z.object({
  packId: z.uuid(),
  items: z.array(EvidenceItemResponseSchema),
});
export type EvidenceListResponse = z.infer<typeof EvidenceListResponseSchema>;
