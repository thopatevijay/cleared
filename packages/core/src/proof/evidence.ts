// EvidenceItem: immutable, append-only, content-addressed by sha256 (architecture §2 invariants).
// M2-01 adds the intake rules: caps, accepted types, text normalisation and the sha256 rule. These are
// pure checks; byte handling (sniffing, re-encoding, hashing) lives in packages/adapters.
import { z } from "zod";
import { EVIDENCE_FILE_MAX_BYTES, EVIDENCE_FILE_MIMES } from "../disputes/dispute.ts";
import type { EvidenceItemId, ProofPackId, Sha256, WorkspaceId } from "../ids.ts";
import { err, ok, type Result } from "../result.ts";
import type { Instant } from "../time.ts";
import type { PackState } from "./pack.ts";

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

/**
 * Kinds a seller may add through the intake routes. `scope_snapshot` and `client_ack` are produced by
 * Cleared itself (M3-06, M3-07); a seller-supplied file must never pose as a client's acknowledgement.
 */
export const SELLER_EVIDENCE_KINDS = ["scope", "delivery", "communication", "shipment", "invoice"] as const;
export type SellerEvidenceKind = (typeof SELLER_EVIDENCE_KINDS)[number];
export const SellerEvidenceKindSchema = z.enum(SELLER_EVIDENCE_KINDS);

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

// --- Caps (PayPal's evidence types and size; the rest bound the parse cost of untrusted files) ---

/** jpg, png, gif, pdf: the file types PayPal accepts as dispute evidence. */
export const EVIDENCE_MIMES = EVIDENCE_FILE_MIMES;
export type EvidenceMime = (typeof EVIDENCE_MIMES)[number];
/** A stored file must be filable with PayPal later, so the same strict bound applies: `< 10_000_000`. */
export const EVIDENCE_MAX_BYTES = EVIDENCE_FILE_MAX_BYTES;
export const EVIDENCE_MAX_PDF_PAGES = 30;
export const EVIDENCE_MAX_PIXELS = 25_000_000;
export const EVIDENCE_TEXT_MAX_CHARS = 50_000;
export const EVIDENCE_ITEMS_PER_PACK = 50;
export const EVIDENCE_WORKSPACE_MAX_BYTES = 200_000_000;

export const EVIDENCE_ERROR_CODES = [
  "EVIDENCE_TYPE",
  "EVIDENCE_TOO_LARGE",
  "EVIDENCE_TOO_MANY_PAGES",
  "EVIDENCE_ENCRYPTED",
  "EVIDENCE_TOO_MANY_PIXELS",
  "EVIDENCE_UNREADABLE",
  "EVIDENCE_TEXT_EMPTY",
  "EVIDENCE_TEXT_TOO_LONG",
  "EVIDENCE_PACK_FULL",
  "EVIDENCE_WORKSPACE_FULL",
] as const;
export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

export interface EvidenceRejection {
  readonly code: EvidenceErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/** The ADR 0003 envelope carries snake_case codes: `EVIDENCE_TYPE` travels as `evidence_type`. */
export function evidenceWireCode(code: EvidenceErrorCode): string {
  return code.toLowerCase();
}

function reject(
  code: EvidenceErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): Result<never, EvidenceRejection> {
  return err({ code, message, details });
}

type Check<T = true> = Result<T, EvidenceRejection>;

/** Size is checked first, on the raw upload and again on the re-encoded bytes. */
export function checkEvidenceSize(sizeBytes: number): Check {
  if (sizeBytes >= EVIDENCE_MAX_BYTES) {
    return reject("EVIDENCE_TOO_LARGE", "Files must be under 10 MB.", {
      sizeBytes,
      maxBytes: EVIDENCE_MAX_BYTES - 1,
    });
  }
  return ok(true);
}

/** `sniffed` is the type found from the file's magic bytes (never its name or the client's mime). */
export function checkEvidenceType(sniffed: string | null): Check<EvidenceMime> {
  const mime = EVIDENCE_MIMES.find((m) => m === sniffed);
  if (mime === undefined) {
    return reject("EVIDENCE_TYPE", "Only JPG, PNG, GIF and PDF files are accepted.", { sniffed });
  }
  return ok(mime);
}

/** Dimensions come from the image header, before any pixel is decoded. */
export function checkImagePixels(width: number, height: number): Check {
  const pixels = width * height;
  if (!Number.isFinite(pixels) || pixels <= 0) {
    return reject("EVIDENCE_UNREADABLE", "The image could not be read.", { width, height });
  }
  if (pixels > EVIDENCE_MAX_PIXELS) {
    return reject("EVIDENCE_TOO_MANY_PIXELS", "Images must be at most 25 megapixels.", {
      width,
      height,
      maxPixels: EVIDENCE_MAX_PIXELS,
    });
  }
  return ok(true);
}

export function checkPdf(info: { readonly encrypted: boolean; readonly pages: number }): Check {
  if (info.encrypted) return reject("EVIDENCE_ENCRYPTED", "Password-protected PDFs are not accepted.");
  if (info.pages > EVIDENCE_MAX_PDF_PAGES) {
    return reject("EVIDENCE_TOO_MANY_PAGES", "PDFs must have at most 30 pages.", {
      pages: info.pages,
      maxPages: EVIDENCE_MAX_PDF_PAGES,
    });
  }
  if (info.pages < 1) return reject("EVIDENCE_UNREADABLE", "The PDF has no pages.");
  return ok(true);
}

/** Per-pack count and per-workspace bytes, checked inside the intake transaction. */
export function checkEvidenceCapacity(input: {
  readonly itemsInPack: number;
  readonly workspaceBytes: number;
  readonly addBytes: number;
}): Check {
  if (input.itemsInPack >= EVIDENCE_ITEMS_PER_PACK) {
    return reject("EVIDENCE_PACK_FULL", "This proof pack already has 50 evidence items.", {
      maxItems: EVIDENCE_ITEMS_PER_PACK,
    });
  }
  if (input.workspaceBytes + input.addBytes > EVIDENCE_WORKSPACE_MAX_BYTES) {
    return reject("EVIDENCE_WORKSPACE_FULL", "This workspace has reached its 200 MB evidence limit.", {
      usedBytes: input.workspaceBytes,
      maxBytes: EVIDENCE_WORKSPACE_MAX_BYTES,
    });
  }
  return ok(true);
}

// --- Text and the sha256 rule ---

/** NFC, and `\r\n` → `\n`: the same chat pasted on Windows or macOS hashes the same. */
export function normaliseEvidenceText(text: string): string {
  return text.normalize("NFC").replaceAll("\r\n", "\n");
}

/** Validates pasted text and returns its normalised form (what is stored and hashed). */
export function checkEvidenceText(raw: string): Check<string> {
  const text = normaliseEvidenceText(raw);
  if (text.trim() === "") return reject("EVIDENCE_TEXT_EMPTY", "Paste some text first.");
  if (text.length > EVIDENCE_TEXT_MAX_CHARS) {
    return reject("EVIDENCE_TEXT_TOO_LONG", "Text must be at most 50,000 characters.", {
      length: text.length,
      maxChars: EVIDENCE_TEXT_MAX_CHARS,
    });
  }
  if (text.includes("\u0000")) return reject("EVIDENCE_UNREADABLE", "The text contains a NUL character.");
  return ok(text);
}

/**
 * The sha256 rule: a file item hashes its **stored** (re-encoded) bytes; a text item hashes the UTF-8
 * bytes of its normalised text. This returns the bytes to hash; the adapter computes the digest.
 */
export function evidenceHashInput(
  input:
    { readonly kind: "file"; readonly bytes: Uint8Array } | { readonly kind: "text"; readonly text: string },
): Uint8Array {
  if (input.kind === "file") return input.bytes;
  return new TextEncoder().encode(normaliseEvidenceText(input.text));
}

/**
 * The pack's state after new evidence (architecture §2: new evidence marks a checked pack stale). An
 * empty pack starts collecting; collecting and stale packs stay as they are.
 */
export function packStateAfterEvidence(state: PackState): PackState {
  switch (state) {
    case "empty":
      return "collecting";
    case "checked":
    case "ready":
      return "stale";
    case "collecting":
    case "stale":
      return state;
  }
}
