// M2-01: type by magic bytes (never the name), and image dimensions from the header alone.
import { describe, expect, it } from "vitest";
import { fixtureFile, sampleEvidence } from "./files.fixtures.ts";
import { imageDimensions, sniffMime } from "./sniff.ts";

describe("sniffMime", () => {
  it.each([
    ["photo-exif.jpg", "image/jpeg"],
    ["screenshot-exif.png", "image/png"],
    ["animation.gif", "image/gif"],
    ["text-layer.pdf", "application/pdf"],
    ["encrypted.pdf", "application/pdf"],
  ])("%s → %s", async (name, mime) => {
    expect(await sniffMime(fixtureFile(name))).toBe(mime);
  });

  it("an HTML file named .png is not an image", async () => {
    expect(await sniffMime(fixtureFile("html-named.png"))).toBeNull();
  });

  it("other binary formats are reported as what they are (and the core check refuses them)", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    expect(await sniffMime(zip)).not.toMatch(/^(image\/(jpeg|png|gif)|application\/pdf)$/);
    expect(await sniffMime(new Uint8Array())).toBeNull();
  });
});

describe("imageDimensions (header only)", () => {
  it("reads png, gif and jpeg headers", () => {
    expect(imageDimensions(fixtureFile("screenshot-exif.png"), "image/png")).toEqual({
      width: 64,
      height: 48,
    });
    expect(imageDimensions(fixtureFile("animation.gif"), "image/gif")).toEqual({ width: 64, height: 48 });
    expect(imageDimensions(fixtureFile("photo-exif.jpg"), "image/jpeg")).toEqual({ width: 64, height: 48 });
    expect(imageDimensions(sampleEvidence("screenshot-logo.png"), "image/png")).toEqual({
      width: 900,
      height: 520,
    });
  });

  it("reads a 26 MP size from the first 24 bytes, without the pixel data", () => {
    const header = fixtureFile("huge-26mp.png").slice(0, 24);
    expect(imageDimensions(header, "image/png")).toEqual({ width: 5200, height: 5000 });
  });

  it("a truncated or malformed header is null", () => {
    expect(imageDimensions(fixtureFile("screenshot-exif.png").slice(0, 20), "image/png")).toBeNull();
    expect(imageDimensions(new Uint8Array([0x47, 0x49, 0x46]), "image/gif")).toBeNull();
    expect(imageDimensions(fixtureFile("photo-exif.jpg").slice(0, 30), "image/jpeg")).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00]), "image/jpeg")).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0, 0]), "image/jpeg")).toBeNull();
    expect(imageDimensions(fixtureFile("text-layer.pdf"), "application/pdf")).toBeNull();
  });

  it("skips fill bytes and standalone markers before the frame header", () => {
    const jpeg = fixtureFile("photo-exif.jpg");
    const padded = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, ...jpeg.slice(2)]);
    expect(imageDimensions(padded, "image/jpeg")).toEqual({ width: 64, height: 48 });
  });
});
