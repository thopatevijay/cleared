// File type by magic bytes (M2-01): the filename and the client's mime are never consulted. Image
// dimensions are read from the header, before any pixel is decoded, so a decompression bomb is refused
// without allocating its bitmap.
import { fileTypeFromBuffer } from "file-type";

/** The sniffed mime, or `null` when the bytes match no known binary format (text, HTML, SVG…). */
export async function sniffMime(bytes: Uint8Array): Promise<string | null> {
  const found = await fileTypeFromBuffer(bytes);
  return found?.mime ?? null;
}

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

const be16 = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const le16 = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const be32 = (b: Uint8Array, i: number): number => be16(b, i) * 65536 + be16(b, i + 2);

function pngDimensions(b: Uint8Array): Dimensions | null {
  // signature (8) · IHDR length (4) · "IHDR" (4) · width (4) · height (4)
  const ihdr = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
  if (b.length < 24 || ihdr !== "IHDR") return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifDimensions(b: Uint8Array): Dimensions | null {
  // "GIF8?a" (6) · logical screen width (2, LE) · height (2, LE)
  if (b.length < 10) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

/** Start-of-frame markers (SOF0–SOF15 minus DHT C4, JPG C8 and DAC CC) carry the frame size. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(b: Uint8Array): Dimensions | null {
  let i = 2; // after SOI (FF D8)
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // standalone markers have no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any frame header
    const length = be16(b, i + 2);
    if (SOF.has(marker)) {
      if (i + 8 >= b.length) return null;
      return { width: be16(b, i + 7), height: be16(b, i + 5) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** Width and height from the image header; `null` when the header is truncated or malformed. */
export function imageDimensions(bytes: Uint8Array, mime: string): Dimensions | null {
  switch (mime) {
    case "image/png":
      return pngDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    default:
      return null;
  }
}
