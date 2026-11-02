// The scope snapshot PDF (M3-07, ADR 0018). Built on the M2-07 helpers: pdf-lib, the embedded Hind font
// (OFL, Latin + Devanagari: `assets/fonts/`), `wrapText`, A4 and the same fixed metadata, so the same
// document always gives the same bytes and sha256. Text goes through `glyph-text.ts` (shaped outlines plus
// an invisible logical-order text layer), so Devanagari both reads right and extracts verbatim. It says "scope snapshot", never "signed": the only
// mention of a signature is the negating footer, on every page.
import { createHash } from "node:crypto";
import fontkit from "@cantoo/fontkit";
import { PDFDocument, rgb, type PDFPage } from "@cantoo/pdf-lib";
import {
  SCOPE_SNAPSHOT_FOOTER,
  SCOPE_SNAPSHOT_NOT_ACKNOWLEDGED,
  SCOPE_SNAPSHOT_TITLE,
  type ScopeSnapshotDocument,
} from "@cleared/core";
import { EVIDENCE_LIMITS } from "../paypal/disputes.ts";
import { loadEvidenceFont, wrapText } from "./compile-evidence.ts";
import { glyphText, type GlyphText } from "./glyph-text.ts";

export interface RenderedSnapshot {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly pageCount: number;
}

const PAGE: [number, number] = [595.28, 841.89]; // A4, as M2-07
const MARGIN = 48;
const WIDTH = PAGE[0] - 2 * MARGIN;
const FOOTER_SIZE = 8;
const FOOTER_TOP = MARGIN + 3 * 11; // room for a wrapped footer
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.45);

type Style = { readonly size: number; readonly leading: number; readonly muted?: boolean };
const H1: Style = { size: 18, leading: 26 };
const H2: Style = { size: 12.5, leading: 20 };
const BODY: Style = { size: 10.5, leading: 15 };
const SMALL: Style = { size: 8.5, leading: 12, muted: true };

interface Flow {
  readonly text: (s: string, style: Style) => void;
  readonly gap: (points: number) => void;
}

/** A cursor that flows wrapped lines down A4 pages, opening a new page above the footer band. */
function flowOn(doc: PDFDocument, gt: GlyphText): Flow {
  let page: PDFPage | null = null;
  let y = 0;
  const room = (leading: number): PDFPage => {
    if (page === null || y - leading < FOOTER_TOP) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN - 6;
    }
    return page;
  };
  return {
    text(s, style) {
      for (const line of wrapText(s, gt.font, style.size, WIDTH)) {
        const p = room(style.leading);
        if (line !== "")
          gt.draw(p, line, { x: MARGIN, y, size: style.size, color: style.muted === true ? MUTED : INK });
        y -= style.leading;
      }
    },
    gap(points) {
      y -= points;
    },
  };
}

/** "2026-11-02 14:05 (Asia/Kolkata)": the seller's local time, Latin digits, fixed format. */
export function localTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    numberingSystem: "latn",
  }).formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} (${timeZone})`;
}

function body(flow: Flow, d: ScopeSnapshotDocument): void {
  flow.text(SCOPE_SNAPSHOT_TITLE, H1);
  flow.text(`Generator: Cleared · generated at ${d.generatedAt}`, SMALL);
  flow.gap(10);
  flow.text("Payment", H2);
  flow.text(`PayPal capture id: ${d.payment.captureId}`, BODY);
  flow.text(`Amount: ${d.payment.amount} ${d.payment.currency}`, BODY);
  flow.text(`Date: ${d.payment.date}`, BODY);
  flow.gap(10);
  flow.text("Agreed scope (verbatim, as the seller provided it)", H2);
  flow.text(`Scope evidence sha256: ${d.scope.sha256}`, SMALL);
  flow.gap(4);
  flow.text(d.scope.text ?? "The scope was provided as a file without a text layer; its sha256 is above.", BODY);
  flow.gap(10);
  flow.text("Delivery evidence (metadata only)", H2);
  if (d.delivery.length === 0) flow.text("No delivery evidence recorded.", BODY);
  for (const item of d.delivery) flow.text(`${item.kind} · added ${item.createdAt} · sha256 ${item.sha256}`, SMALL);
  flow.gap(10);
  flow.text("Client acknowledgement", H2);
  if (d.ack === null) flow.text(SCOPE_SNAPSHOT_NOT_ACKNOWLEDGED, BODY);
  else {
    flow.text(`Typed name: ${d.ack.typedName}`, BODY);
    flow.text(`Accepted at: ${d.ack.acceptedAt} (UTC)`, BODY);
    flow.text(`Seller's local time: ${localTime(d.ack.acceptedAt, d.timeZone)}`, BODY);
    flow.text(`IP address: ${d.ack.ip}`, BODY);
    flow.text(`User agent: ${d.ack.userAgent}`, SMALL);
    flow.text(`Acknowledgement record sha256: ${d.ack.sha256}`, SMALL);
  }
  flow.gap(10);
  flow.text(`Generated at: ${d.generatedAt}`, BODY);
}

function footers(doc: PDFDocument, gt: GlyphText): void {
  const lines = wrapText(SCOPE_SNAPSHOT_FOOTER, gt.font, FOOTER_SIZE, WIDTH);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    let y = MARGIN + 11 * lines.length;
    for (const line of [...lines, `Page ${String(i + 1)} of ${String(pages.length)}`]) {
      gt.draw(page, line, { x: MARGIN, y, size: FOOTER_SIZE, color: MUTED });
      y -= 11;
    }
  });
}

/** Renders the snapshot; throws when the result would breach PayPal's < 10 MB evidence limit. */
export async function renderScopeSnapshotPdf(d: ScopeSnapshotDocument): Promise<RenderedSnapshot> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const gt = await glyphText(doc, await loadEvidenceFont());
  body(flowOn(doc, gt), d);
  footers(doc, gt);
  const at = new Date(d.generatedAt);
  doc.setTitle(`${SCOPE_SNAPSHOT_TITLE} · PayPal capture ${d.payment.captureId}`);
  doc.setSubject(`Cleared scope snapshot of proof pack ${d.packId}`);
  doc.setProducer("Cleared");
  doc.setCreator("Cleared");
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const bytes = await doc.save({ useObjectStreams: true });
  if (bytes.byteLength >= EVIDENCE_LIMITS.maxFileBytes)
    throw new Error(`scope snapshot is ${String(bytes.byteLength)} bytes (limit < ${String(EVIDENCE_LIMITS.maxFileBytes)})`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, size: bytes.byteLength, pageCount: doc.getPageCount() };
}

/** Characters of `text` the embedded font has no glyph for (they would print as boxes). */
export async function missingGlyphs(text: string): Promise<string[]> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadEvidenceFont(), { subset: true });
  const have = new Set(font.getCharacterSet());
  return [...new Set(Array.from(text.replace(/\s/g, "")))].filter((ch) => !have.has(ch.codePointAt(0) ?? 0));
}

/** Loads a PDF with pdf-lib (throws when it does not parse) and reads what the snapshot fixes. */
export async function readPdfInfo(
  bytes: Uint8Array,
): Promise<{ pageCount: number; producer: string | undefined; creationDate: Date | undefined }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false }); // a plain load rewrites the producer
  return { pageCount: doc.getPageCount(), producer: doc.getProducer(), creationDate: doc.getCreationDate() };
}
