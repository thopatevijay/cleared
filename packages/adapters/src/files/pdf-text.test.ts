// M2-01: the PDF text layer is extracted deterministically (pdf.js, no model) and normalised.
import { describe, expect, it } from "vitest";
import { fixtureFile, sampleEvidence } from "./files.fixtures.ts";
import { extractPdfText } from "./pdf-text.ts";
import { resavePdf } from "./reencode.ts";

describe("extractPdfText", () => {
  it("extracts the synthetic delivery note's text", async () => {
    expect(await extractPdfText(fixtureFile("text-layer.pdf"))).toBe(
      "Synthetic delivery note page 1\nOrder LOGO-1042 delivered: logo.svg, logo.png",
    );
  });

  it("extracts the M0 sample brand guide (delivery-logo.pdf) after re-saving, as stored", async () => {
    const text = await extractPdfText(await resavePdf(sampleEvidence("delivery-logo.pdf")));
    expect(text).toContain("Northwind Tea Co.");
    expect(text).toContain("HEX #1B7F79");
    expect(text).not.toContain("\r");
  });

  it("joins pages with a newline and is deterministic", async () => {
    const a = await extractPdfText(fixtureFile("pages-30.pdf"));
    const b = await extractPdfText(fixtureFile("pages-30.pdf"));
    expect(a).toBe(b);
    expect(a?.split("\n")).toHaveLength(30);
    expect(a?.split("\n")[29]).toBe("Thirty page 30");
  });

  it("does not modify the caller's buffer (pdf.js would detach it)", async () => {
    const bytes = fixtureFile("text-layer.pdf");
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("a PDF with no text layer gives null", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    expect(await extractPdfText(await doc.save())).toBeNull();
  });
});
