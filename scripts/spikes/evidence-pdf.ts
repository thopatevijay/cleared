// Builds the synthetic sample evidence PDF (fixtures/samples/evidence/delivery-note.pdf): plain ASCII,
// one page, Helvetica, a correct xref table. All names and ids in it are invented (data policy §9.1).
//
//   pnpm tsx scripts/spikes/evidence-pdf.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_PDF_PATH = fileURLToPath(
  new URL("../../fixtures/samples/evidence/delivery-note.pdf", import.meta.url),
);

const LINES = [
  "Delivery note (synthetic sample, Cleared sandbox test data)",
  "",
  "Seller: Example Handloom Studio, Jaipur, India",
  "Buyer: Sample Buyer, Austin, TX, USA",
  "Order reference: SAMPLE-ORDER-0001",
  "Item: 1 x hand-block-printed cotton table runner (180 x 35 cm)",
  "Dispatched: 2026-10-20 via India Post, tracking EX000000000IN (sample)",
  "Delivered: 2026-10-27, left at front desk (carrier scan, sample)",
  "",
  "The item matched the listing photos and description.",
  "This document is synthetic and contains no real personal data.",
];

function escape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function buildEvidencePdf(): Buffer {
  const content = ["BT /F1 11 Tf 56 760 Td 15 TL", ...LINES.map((l) => `(${escape(l)}) '`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dirname(EVIDENCE_PDF_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PDF_PATH, buildEvidencePdf());
  console.log(`wrote ${EVIDENCE_PDF_PATH}`);
}
