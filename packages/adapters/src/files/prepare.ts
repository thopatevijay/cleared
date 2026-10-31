// One uploaded file → the bytes Cleared stores (M2-01). Order: size → magic-byte type → header caps
// (pixels, or encryption + pages) → re-encode → size again → PDF text → sha256 of the stored bytes.
// Every refusal is a typed `EvidenceRejection` from @cleared/core; nothing here touches the database.
import {
  checkEvidenceSize,
  checkEvidenceType,
  checkImagePixels,
  checkPdf,
  err,
  ok,
  type EvidenceMime,
  type EvidenceRejection,
  type Result,
  type Sha256,
} from "@cleared/core";
import { sha256Of } from "./hash.ts";
import { extractPdfText } from "./pdf-text.ts";
import { inspectPdf, reencodeImage, resavePdf } from "./reencode.ts";
import { imageDimensions, sniffMime } from "./sniff.ts";

export interface PreparedFile {
  readonly mime: EvidenceMime;
  /** the re-encoded bytes: what is stored and hashed */
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly sha256: Sha256;
  /** PDF text layer; `null` for images and for PDFs without one */
  readonly text: string | null;
  readonly uploadedSize: number;
}

const unreadable = (message: string): Result<never, EvidenceRejection> =>
  err({ code: "EVIDENCE_UNREADABLE", message, details: null });

async function reencode(
  bytes: Uint8Array,
  mime: EvidenceMime,
): Promise<Result<{ bytes: Uint8Array; text: string | null }, EvidenceRejection>> {
  if (mime === "application/pdf") {
    const info = await inspectPdf(bytes);
    const pdf = checkPdf(info);
    if (!pdf.ok) return pdf;
    const stored = await resavePdf(bytes);
    return ok({ bytes: stored, text: await extractPdfText(stored) });
  }
  const dims = imageDimensions(bytes, mime);
  if (dims === null) return unreadable("The image header could not be read.");
  const pixels = checkImagePixels(dims.width, dims.height);
  if (!pixels.ok) return pixels;
  return ok({ bytes: await reencodeImage(bytes, mime), text: null });
}

export async function prepareEvidenceFile(
  upload: Uint8Array,
): Promise<Result<PreparedFile, EvidenceRejection>> {
  const size = checkEvidenceSize(upload.byteLength);
  if (!size.ok) return size;
  const type = checkEvidenceType(await sniffMime(upload));
  if (!type.ok) return type;
  let out: { bytes: Uint8Array; text: string | null };
  try {
    const r = await reencode(upload, type.value);
    if (!r.ok) return r;
    out = r.value;
  } catch {
    // UnreadableFileError, or pdf.js / libvips errors on malformed input: a refusal, never a 500.
    return unreadable("The file could not be read.");
  }
  const stored = checkEvidenceSize(out.bytes.byteLength);
  if (!stored.ok) return stored;
  return ok({
    mime: type.value,
    bytes: out.bytes,
    size: out.bytes.byteLength,
    sha256: sha256Of(out.bytes),
    text: out.text,
    uploadedSize: upload.byteLength,
  });
}
