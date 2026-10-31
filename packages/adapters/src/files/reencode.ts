// Re-encoding (M2-01): the stored bytes are never the uploaded ones. Images are decoded and encoded again
// by sharp (libvips), which drops EXIF/XMP/ICC metadata and anything appended after the image data (a
// polyglot payload). PDFs are parsed and their pages copied into a fresh document, which drops
// document-level JavaScript, open actions, embedded files, page annotations and trailing bytes.
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { EVIDENCE_MAX_PIXELS, type EvidenceMime } from "@cleared/core";
import sharp from "sharp";

export type ImageMime = Exclude<EvidenceMime, "application/pdf">;

/** Thrown when a file passes the header checks but cannot be decoded or parsed. */
export class UnreadableFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnreadableFileError";
  }
}

/** Decodes and re-encodes in the same format, without any metadata. */
export async function reencodeImage(bytes: Uint8Array, mime: ImageMime): Promise<Uint8Array> {
  const animated = mime === "image/gif";
  // limitInputPixels is a second guard behind the header check; failOn "error" rejects corrupt data.
  let img = sharp(bytes, { limitInputPixels: EVIDENCE_MAX_PIXELS, failOn: "error", animated });
  if (!animated) img = img.autoOrient(); // bake EXIF orientation in before the EXIF is dropped
  try {
    switch (mime) {
      case "image/jpeg":
        return new Uint8Array(await img.jpeg({ quality: 90 }).toBuffer());
      case "image/png":
        return new Uint8Array(await img.png({ compressionLevel: 9 }).toBuffer());
      case "image/gif":
        return new Uint8Array(await img.gif().toBuffer());
    }
  } catch (cause) {
    throw new UnreadableFileError("image could not be decoded", { cause });
  }
}

export interface PdfInfo {
  readonly encrypted: boolean;
  readonly pages: number;
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (cause) {
    throw new UnreadableFileError("PDF could not be parsed", { cause });
  }
}

/** Encryption and page count, read without decrypting anything. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await loadPdf(bytes);
  try {
    // A file with no catalog or page tree parses but throws here.
    return { encrypted: doc.isEncrypted, pages: doc.getPageCount() };
  } catch (cause) {
    throw new UnreadableFileError("PDF has no readable page tree", { cause });
  }
}

const PAGE_KEYS_DROPPED = ["Annots", "AA"] as const;

/** Copies every page into a new document and saves it; call only after `inspectPdf` passed. */
export async function resavePdf(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await loadPdf(bytes);
  try {
    const out = await PDFDocument.create({ updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) {
      for (const key of PAGE_KEYS_DROPPED) page.node.delete(PDFName.of(key));
      out.addPage(page);
    }
    return await out.save({ useObjectStreams: false });
  } catch (cause) {
    throw new UnreadableFileError("PDF could not be re-saved", { cause });
  }
}
