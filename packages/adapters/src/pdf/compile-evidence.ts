// One compiled evidence PDF per dispute draft (M2-07). PayPal files are all-or-nothing per call, so the
// selected pack items go into a single PDF: a cover page (dispute id, capture id, amount, reason, and an index
// of every item with its sha256, date and pages), then one page group per item in the selected order:
// - a PDF item: its pages, copied unchanged
// - an image: one page, scaled to fit (GIF is converted to PNG first; PDF has no GIF images)
// - pasted text: typeset in Hind (OFL, Latin + Devanagari: `assets/fonts/`) through `glyph-text.ts` (M3-07):
//   shaped Devanagari on the page and the typed text in its text layer, so it reads and extracts right
//   (BL-01 6538667077: plain `drawText` shapes too, but extracts a pre-base matra before its consonant)
// The result must be < 10 MB (`EVIDENCE_LIMITS.maxFileBytes`, exclusive); over → `pdf_too_large` listing every
// item's size so the seller can deselect. Nothing is dropped silently. Deterministic for the same input.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import fontkit from "@cantoo/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { err, ok, type Result } from "@cleared/core";
import sharp from "sharp";
import { EVIDENCE_LIMITS } from "../paypal/disputes.ts";
import { glyphText, type GlyphText } from "./glyph-text.ts";

export const EVIDENCE_FONT_URL = new URL("../../assets/fonts/Hind-Regular.ttf", import.meta.url);

export interface CompileItem {
  /** evidence item uuid */
  readonly id: string;
  /** the pack ref (`E3`), shown on the cover */
  readonly ref: string;
  readonly kind: string;
  readonly sha256: string;
  /** ISO 8601 */
  readonly addedAt: string;
  readonly mime: string | null;
  /** the stored file (BlobStore); null for pasted text */
  readonly bytes: Uint8Array | null;
  readonly text: string | null;
}

export interface EvidenceCover {
  readonly disputeId: string;
  readonly captureId: string | null;
  readonly amount: { readonly value: string; readonly currency_code: string } | null;
  readonly reason: string | null;
  readonly evidenceType: string;
  /** ISO 8601; also the PDF's creation date, so the same input compiles to the same bytes */
  readonly compiledAt: string;
}

export interface PageGroup {
  readonly itemId: string;
  readonly ref: string;
  /** 1-based, in the compiled PDF (page 1 is the cover) */
  readonly firstPage: number;
  readonly pageCount: number;
}

export interface CompiledEvidence {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly pageCount: number;
  readonly groups: readonly PageGroup[];
}

export interface ItemSize {
  readonly id: string;
  readonly ref: string;
  readonly sha256: string;
  readonly bytes: number;
}

export type CompileError =
  | { readonly code: "no_items" }
  | { readonly code: "item_unreadable"; readonly itemId: string; readonly detail: string }
  | {
      readonly code: "pdf_too_large";
      readonly size: number;
      /** exclusive */
      readonly limit: number;
      readonly items: readonly ItemSize[];
    };

const PAGE: [number, number] = [595.28, 841.89]; // A4
const MARGIN = 48;
const BODY_SIZE = 10.5;
const LEADING = 15;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);

let fontBytes: Promise<Uint8Array> | null = null;
/** Hind's bytes, read once per process (shared with the M3-07 scope snapshot). */
export const loadEvidenceFont = (): Promise<Uint8Array> => (fontBytes ??= readFile(EVIDENCE_FONT_URL));

export const itemSize = (i: CompileItem): number =>
  i.bytes?.byteLength ?? Buffer.byteLength(i.text ?? "", "utf8");

export async function compileEvidencePdf(
  cover: EvidenceCover,
  items: readonly CompileItem[],
): Promise<Result<CompiledEvidence, CompileError>> {
  if (items.length === 0) return err({ code: "no_items" });
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadEvidenceFont(), { subset: true });
  // the whole font is embedded only when a text item needs the extractable text layer
  let gt: GlyphText | null = null;
  const body = async (): Promise<GlyphText> => (gt ??= await glyphText(doc, await loadEvidenceFont()));
  const groups: PageGroup[] = [];
  for (const item of items) {
    const before = doc.getPageCount();
    try {
      await addItem(doc, font, body, item);
    } catch (e) {
      return err({
        code: "item_unreadable",
        itemId: item.id,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    groups.push({
      itemId: item.id,
      ref: item.ref,
      firstPage: before + 2,
      pageCount: doc.getPageCount() - before,
    });
  }
  drawCover(doc.insertPage(0, PAGE), font, cover, items, groups);
  const at = new Date(cover.compiledAt);
  doc.setTitle(`Evidence for PayPal dispute ${cover.disputeId}`);
  doc.setProducer("Cleared");
  doc.setCreator("Cleared");
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const bytes = await doc.save({ useObjectStreams: true });
  if (bytes.byteLength >= EVIDENCE_LIMITS.maxFileBytes) {
    return err({
      code: "pdf_too_large",
      size: bytes.byteLength,
      limit: EVIDENCE_LIMITS.maxFileBytes,
      items: items.map((i) => ({ id: i.id, ref: i.ref, sha256: i.sha256, bytes: itemSize(i) })),
    });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return ok({ bytes, sha256, size: bytes.byteLength, pageCount: doc.getPageCount(), groups });
}

async function addItem(
  doc: PDFDocument,
  font: PDFFont,
  body: () => Promise<GlyphText>,
  item: CompileItem,
): Promise<void> {
  if (item.bytes !== null && item.mime === "application/pdf") {
    const src = await PDFDocument.load(item.bytes);
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
    return;
  }
  if (item.bytes !== null && item.mime?.startsWith("image/") === true) {
    await addImage(doc, font, item, item.bytes, item.mime);
    return;
  }
  if (item.text !== null) {
    typeset(doc, font, await body(), item);
    return;
  }
  throw new Error(`item ${item.id} has neither a file nor text`);
}

async function addImage(
  doc: PDFDocument,
  font: PDFFont,
  item: CompileItem,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  const image =
    mime === "image/jpeg"
      ? await doc.embedJpg(bytes)
      : await doc.embedPng(mime === "image/png" ? bytes : await sharp(bytes).png().toBuffer());
  const page = doc.addPage(PAGE);
  const top = header(page, font, item);
  const [w, h] = [PAGE[0] - 2 * MARGIN, top - MARGIN];
  const scale = Math.min(w / image.width, h / image.height, 1);
  const [iw, ih] = [image.width * scale, image.height * scale];
  page.drawImage(image, { x: MARGIN + (w - iw) / 2, y: top - ih, width: iw, height: ih });
}

/** The item's label line at the top of a page it owns; returns the y below it. */
function header(page: PDFPage, font: PDFFont, item: CompileItem): number {
  const y = PAGE[1] - MARGIN;
  page.drawText(`${item.ref} · ${item.kind} · added ${item.addedAt.slice(0, 10)} · sha256 ${item.sha256}`, {
    x: MARGIN,
    y,
    size: 7.5,
    font,
    color: MUTED,
  });
  return y - 18;
}

/** Breaks text into lines that fit `width` (words, then characters for a word longer than a line). */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (s: string): boolean => font.widthOfTextAtSize(s, size) <= width;
  const lines: string[] = [];
  for (const para of text.replace(/\t/g, "    ").split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const next = line === "" ? word : `${line} ${word}`;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line !== "") lines.push(line);
      line = "";
      for (const ch of Array.from(word)) {
        if (!fits(line + ch)) {
          lines.push(line);
          line = "";
        }
        line += ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

function typeset(doc: PDFDocument, font: PDFFont, gt: GlyphText, item: CompileItem): void {
  const lines = wrapText(item.text ?? "", gt.font, BODY_SIZE, PAGE[0] - 2 * MARGIN);
  let page: PDFPage | null = null;
  let y = 0;
  for (const line of lines) {
    if (page === null || y < MARGIN) {
      page = doc.addPage(PAGE);
      y = header(page, font, item);
    }
    if (line !== "") gt.draw(page, line, { x: MARGIN, y, size: BODY_SIZE, color: INK });
    y -= LEADING;
  }
}

function drawCover(
  page: PDFPage,
  font: PDFFont,
  cover: EvidenceCover,
  items: readonly CompileItem[],
  groups: readonly PageGroup[],
): void {
  let y = PAGE[1] - MARGIN - 6;
  const text = (s: string, size: number, color = INK, x = MARGIN): void => {
    page.drawText(s, { x, y, size, font, color });
  };
  text(`Evidence for PayPal dispute ${cover.disputeId}`, 16);
  y -= 28;
  const amount = cover.amount ? `${cover.amount.value} ${cover.amount.currency_code}` : "not stated";
  for (const [k, v] of [
    ["Capture", cover.captureId ?? "not linked"],
    ["Amount", amount],
    ["Reason", cover.reason ?? "not stated"],
    ["Evidence type", cover.evidenceType],
    ["Compiled", cover.compiledAt],
  ] as const) {
    text(`${k}: ${v}`, 10.5);
    y -= 16;
  }
  y -= 10;
  text(`Index: ${String(items.length)} item${items.length === 1 ? "" : "s"}, in the order they follow`, 12);
  y -= 22;
  items.forEach((item, n) => {
    const g = groups[n];
    const pages = g ? `${String(g.firstPage)}–${String(g.firstPage + g.pageCount - 1)}` : "";
    text(
      `${String(n + 1)}. ${item.ref} · ${item.kind} · added ${item.addedAt.slice(0, 10)} · pages ${pages}`,
      10,
    );
    y -= 12;
    text(`sha256 ${item.sha256}`, 7.5, MUTED, MARGIN + 14);
    y -= 18;
  });
}
