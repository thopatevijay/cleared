// Generates the synthetic evidence files under fixtures/files/ (M2-01). Every file is synthetic: no real
// photo, person or document. Re-run with `node packages/adapters/test/files/make-fixtures.ts` from the
// repo root; the outputs are committed so tests never depend on this script.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import sharp from "sharp";

const OUT = join(process.cwd(), "fixtures", "files");
mkdirSync(OUT, { recursive: true });

const write = (name: string, bytes: Uint8Array | Buffer | string): void => {
  writeFileSync(join(OUT, name), bytes);
  console.log(`wrote fixtures/files/${name}`);
};

const exif = {
  IFD0: { Make: "SyntheticCam", Model: "Fixture 1", Artist: "Synthetic Seller", Copyright: "fixture" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "18/1 31/1 0/1",
    GPSLongitudeRef: "E",
    GPSLongitude: "73/1 51/1 0/1",
  },
};

const swatch = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 27, g: 127, b: 121 } } });

async function images(): Promise<void> {
  write("photo-exif.jpg", await swatch().jpeg({ quality: 85 }).withExif(exif).toBuffer());
  write("screenshot-exif.png", await swatch().png().withExif(exif).toBuffer());
  write("animation.gif", await swatch().gif().toBuffer());
  // A PNG with an HTML payload appended after IEND (a polyglot): viewers show the image, a sniffing
  // browser could run the script. Re-encoding must drop it.
  const png = await swatch().png().toBuffer();
  write("polyglot.png", Buffer.concat([png, Buffer.from("<html><script>alert('x')</script></html>")]));
  // 26 MP (5200 x 5000), one grey channel: deflate keeps it small on disk.
  const big = sharp({ create: { width: 5200, height: 5000, channels: 3, background: "#808080" } });
  write("huge-26mp.png", await big.toColourspace("b-w").png({ compressionLevel: 9 }).toBuffer());
  write("html-named.png", "<!doctype html><html><body><script>alert(1)</script></body></html>\n");
}

async function textPdf(pages: number, title: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`${title} page ${String(i)}`, { x: 20, y: 150, size: 12, font });
  }
  return doc;
}

const save = (doc: PDFDocument) => doc.save({ useObjectStreams: false });

async function pdfs(): Promise<void> {
  const text = await textPdf(1, "Synthetic delivery note");
  text.getPage(0).drawText("Order LOGO-1042 delivered: logo.svg, logo.png", {
    x: 20,
    y: 120,
    size: 10,
    font: await text.embedFont(StandardFonts.Helvetica),
  });
  write("text-layer.pdf", await save(text));
  write("pages-30.pdf", await save(await textPdf(30, "Thirty")));
  write("pages-31.pdf", await save(await textPdf(31, "Thirty-one")));

  const locked = await textPdf(1, "Encrypted");
  locked.encrypt({ userPassword: "synthetic-user", ownerPassword: "synthetic-owner" });
  write("encrypted.pdf", await save(locked));

  // A PDF with document-level JavaScript (OpenAction) and trailing bytes after %%EOF.
  const active = await textPdf(1, "Active content");
  const js = active.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('x')") });
  active.catalog.set(PDFName.of("OpenAction"), active.context.register(js));
  const bytes = await save(active);
  write(
    "active-content.pdf",
    Buffer.concat([Buffer.from(bytes), Buffer.from("\n<script>alert(2)</script>\n")]),
  );
}

await images();
await pdfs();
