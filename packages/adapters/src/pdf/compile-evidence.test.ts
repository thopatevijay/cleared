// M2-07 AC 5: the compiled evidence PDF on the sample pack (the synthetic M0-07 logo pack, as M2-01 stores it)
// and a selection over PayPal's 10 MB limit. Set PDF_OUT_DIR to keep `sample-evidence.pdf` (Validation Gate).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { EVIDENCE_LIMITS } from "../paypal/disputes.ts";
import { extractPdfText } from "../files/pdf-text.ts";
import { prepareEvidenceFile } from "../files/prepare.ts";
import { compileEvidencePdf, type CompileItem, type EvidenceCover } from "./compile-evidence.ts";

const SAMPLES = new URL("../../../../fixtures/samples/evidence/", import.meta.url);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const COVER: EvidenceCover = {
  disputeId: "PP-R-UVC-10195076",
  captureId: "4FX12345AB678901C",
  amount: { value: "64.00", currency_code: "USD" },
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  evidenceType: "PROOF_OF_FULFILLMENT",
  compiledAt: "2026-10-31T09:00:00.000Z",
};

/** A sample file stored the way M2-01's intake stores it (text normalised; files re-encoded). */
async function sample(file: string, ref: string, kind: string): Promise<CompileItem> {
  const raw = readFileSync(new URL(file, SAMPLES));
  const base = { id: crypto.randomUUID(), ref, kind, addedAt: "2026-10-18T10:00:00.000Z" };
  if (file.endsWith(".txt")) {
    const text = raw.toString("utf8").replace(/\r\n?/g, "\n").normalize("NFC");
    return { ...base, sha256: sha(text), mime: null, bytes: null, text };
  }
  const prepared = await prepareEvidenceFile(new Uint8Array(raw));
  if (!prepared.ok) throw new Error(`${file}: ${prepared.error.code}`);
  const p = prepared.value;
  return { ...base, sha256: p.sha256, mime: p.mime, bytes: p.bytes, text: p.text };
}

const hindi = (): CompileItem => {
  const text =
    "डिलीवरी 18 अक्टूबर को हुई। ग्राहक ने 19 अक्टूबर को फ़ाइलें स्वीकार कीं।\nDelivered on 18 October.";
  return {
    id: crypto.randomUUID(),
    ref: "E5",
    kind: "communication",
    addedAt: "2026-10-19T10:00:00.000Z",
    sha256: sha(text),
    mime: null,
    bytes: null,
    text,
  };
};

describe("compileEvidencePdf (M2-07 AC 5)", () => {
  it("sample pack: opens with pdf-lib, cover + one page group per item, cover lists every sha256, < 10 MB", async () => {
    const items = [
      await sample("delivery-logo.pdf", "E3", "delivery"),
      await sample("screenshot-logo.png", "E4", "delivery"),
      await sample("chat-logo.txt", "E2", "communication"),
      await sample("brief-logo.txt", "E1", "scope"),
      await sample("receipt-shipping.png", "E6", "shipment"),
      hindi(),
    ];
    const r = await compileEvidencePdf(COVER, items);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const out = r.value;
    const dir = process.env["PDF_OUT_DIR"];
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "sample-evidence.pdf"), out.bytes);
    }
    expect(out.size).toBeLessThan(EVIDENCE_LIMITS.maxFileBytes);
    expect(out.sha256).toBe(sha(out.bytes));

    const doc = await PDFDocument.load(out.bytes);
    expect(out.groups).toHaveLength(items.length);
    expect(doc.getPageCount()).toBe(1 + out.groups.reduce((n, g) => n + g.pageCount, 0));
    expect(out.groups.map((g) => g.itemId)).toEqual(items.map((i) => i.id)); // the selected order
    expect(out.groups[0]?.firstPage).toBe(2);
    for (const [a, b] of out.groups.slice(0, -1).map((g, n) => [g, out.groups[n + 1]] as const))
      expect(b?.firstPage).toBe(a.firstPage + a.pageCount);
    // the delivery PDF keeps its own pages; an image is one page
    const src = await PDFDocument.load(items[0]?.bytes ?? new Uint8Array());
    expect(out.groups[0]?.pageCount).toBe(src.getPageCount());
    expect(out.groups[1]?.pageCount).toBe(1);

    const cover = await PDFDocument.create();
    const [first] = await cover.copyPages(doc, [0]);
    if (first) cover.addPage(first);
    const coverText = (await extractPdfText(await cover.save())) ?? "";
    for (const i of items) expect(coverText).toContain(i.sha256);
    for (const s of [
      "PP-R-UVC-10195076",
      "4FX12345AB678901C",
      "64.00 USD",
      "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ])
      expect(coverText).toContain(s);
  });

  it("pasted Devanagari text is typeset with the embedded Hind font (glyphs, not a WinAnsi error)", async () => {
    const r = await compileEvidencePdf(COVER, [hindi()]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const text = (await extractPdfText(r.value.bytes)) ?? "";
    expect(text).toContain("Delivered on 18 October.");
    expect(text).toMatch(/[ऀ-ॿ]/);
    expect(r.value.pageCount).toBe(2);
  });

  it("the same input compiles to the same bytes (the approval binds this hash)", async () => {
    const items = [await sample("brief-logo.txt", "E1", "scope")];
    const [a, b] = await Promise.all([compileEvidencePdf(COVER, items), compileEvidencePdf(COVER, items)]);
    expect(a.ok && b.ok && a.value.sha256 === b.value.sha256).toBe(true);
  });

  it("a long text item flows over several pages of its group", async () => {
    const text = Array.from(
      { length: 160 },
      (_, n) => `Line ${String(n + 1)}: the delivery note continues.`,
    ).join("\n");
    const r = await compileEvidencePdf(COVER, [{ ...hindi(), text, sha256: sha(text) }]);
    expect(r.ok && r.value.groups[0]?.pageCount).toBeGreaterThan(1);
  });

  it("a selection totalling > 10 MB returns pdf_too_large with every item's size (nothing dropped)", async () => {
    const noise = async (seed: number): Promise<CompileItem> => {
      const bytes = new Uint8Array(
        await sharp({
          create: {
            width: 2000,
            height: 1500,
            channels: 3,
            background: "#808080",
            noise: { type: "gaussian", mean: 128 + seed, sigma: 120 },
          },
        })
          .jpeg({ quality: 100 })
          .toBuffer(),
      );
      return {
        id: crypto.randomUUID(),
        ref: `E${String(seed)}`,
        kind: "delivery",
        addedAt: "2026-10-18T10:00:00.000Z",
        sha256: sha(bytes),
        mime: "image/jpeg",
        bytes,
        text: null,
      };
    };
    const items = [await noise(1), await noise(2), await noise(3)];
    for (const i of items) expect(i.bytes?.byteLength).toBeLessThan(EVIDENCE_LIMITS.maxFileBytes);
    const total = items.reduce((n, i) => n + (i.bytes?.byteLength ?? 0), 0);
    expect(total).toBeGreaterThan(EVIDENCE_LIMITS.maxFileBytes);
    const r = await compileEvidencePdf(COVER, items);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      code: "pdf_too_large",
      size: expect.any(Number) as number,
      limit: 10_000_000,
      items: items.map((i) => ({ id: i.id, ref: i.ref, sha256: i.sha256, bytes: i.bytes?.byteLength })),
    });
    if (r.error.code === "pdf_too_large") expect(r.error.size).toBeGreaterThanOrEqual(10_000_000);
  });

  it("no items, or an item with neither file nor text, is a typed error", async () => {
    expect(await compileEvidencePdf(COVER, [])).toEqual({ ok: false, error: { code: "no_items" } });
    const bad = { ...hindi(), text: null };
    expect(await compileEvidencePdf(COVER, [bad])).toMatchObject({
      ok: false,
      error: { code: "item_unreadable", itemId: bad.id },
    });
  });
});
