// M2-01: re-encoded images carry no EXIF (asserted on the output bytes) and lose polyglot payloads;
// re-saved PDFs lose document JavaScript and trailing bytes; corrupt files are UnreadableFileError.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { containsAscii, fixtureFile } from "./files.fixtures.ts";
import { inspectPdf, reencodeImage, resavePdf, UnreadableFileError } from "./reencode.ts";

describe("reencodeImage", () => {
  it.each([
    ["photo-exif.jpg", "image/jpeg", "jpeg"],
    ["screenshot-exif.png", "image/png", "png"],
  ] as const)("%s: the input has EXIF, the output has none", async (name, mime, format) => {
    const input = fixtureFile(name);
    expect((await sharp(input).metadata()).exif).toBeDefined();
    expect(containsAscii(input, "Synthetic Seller")).toBe(true);

    const out = await reencodeImage(input, mime);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(format);
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    // the raw bytes: no Exif segment, none of the EXIF strings, no GPS
    expect(containsAscii(out, "Exif")).toBe(false);
    expect(containsAscii(out, "eXIf")).toBe(false);
    expect(containsAscii(out, "Synthetic Seller")).toBe(false);
    expect(containsAscii(out, "SyntheticCam")).toBe(false);
    expect([meta.width, meta.height]).toEqual([64, 48]);
  });

  it("drops a payload appended after the PNG data (polyglot)", async () => {
    const input = fixtureFile("polyglot.png");
    expect(containsAscii(input, "<script>")).toBe(true);
    const out = await reencodeImage(input, "image/png");
    expect(containsAscii(out, "<script>")).toBe(false);
  });

  it("re-encodes a gif as a gif", async () => {
    const out = await reencodeImage(fixtureFile("animation.gif"), "image/gif");
    expect((await sharp(out).metadata()).format).toBe("gif");
  });

  it("is deterministic: the same input gives the same bytes (so dedupe works after re-encoding)", async () => {
    const a = await reencodeImage(fixtureFile("photo-exif.jpg"), "image/jpeg");
    const b = await reencodeImage(fixtureFile("photo-exif.jpg"), "image/jpeg");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("a corrupt image is UnreadableFileError", async () => {
    const broken = fixtureFile("screenshot-exif.png").slice(0, 60);
    await expect(reencodeImage(broken, "image/png")).rejects.toBeInstanceOf(UnreadableFileError);
  });
});

describe("PDFs", () => {
  it("inspectPdf reports encryption and page count without decrypting", async () => {
    expect(await inspectPdf(fixtureFile("encrypted.pdf"))).toEqual({ encrypted: true, pages: 1 });
    expect(await inspectPdf(fixtureFile("pages-31.pdf"))).toEqual({ encrypted: false, pages: 31 });
    expect(await inspectPdf(fixtureFile("text-layer.pdf"))).toEqual({ encrypted: false, pages: 1 });
  });

  it("resavePdf drops the OpenAction JavaScript and the bytes after %%EOF, and keeps the pages", async () => {
    const input = fixtureFile("active-content.pdf");
    expect(containsAscii(input, "/JavaScript")).toBe(true);
    expect(containsAscii(input, "<script>")).toBe(true);
    const out = await resavePdf(input);
    expect(containsAscii(out, "/JavaScript")).toBe(false);
    expect(containsAscii(out, "/OpenAction")).toBe(false);
    expect(containsAscii(out, "<script>")).toBe(false);
    expect(await inspectPdf(out)).toEqual({ encrypted: false, pages: 1 });
  });

  it("resavePdf is deterministic", async () => {
    const a = await resavePdf(fixtureFile("pages-30.pdf"));
    const b = await resavePdf(fixtureFile("pages-30.pdf"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("a file that is not a PDF is UnreadableFileError", async () => {
    await expect(inspectPdf(new TextEncoder().encode("%PDF-1.7 nonsense"))).rejects.toBeInstanceOf(
      UnreadableFileError,
    );
  });
});
