// The scope snapshot PDF (M3-07, ADR 0018). Built on the M2-07 helpers: pdf-lib, the embedded Hind font
// (OFL, Latin + Devanagari: `assets/fonts/`), `wrapText`, A4 and the same fixed metadata, so the same
// document always gives the same bytes and sha256. Text goes through `glyph-text.ts` (shaped outlines plus
// an invisible logical-order text layer), so Devanagari both reads right and extracts verbatim. It says "scope snapshot", never "signed": the only
// mention of a signature is the negating footer, on every page.
import { createHash } from "node:crypto";
import fontkit from "@cantoo/fontkit";
import { PDFDocument, rgb, type PDFPage } from "@cantoo/pdf-lib";
import {
  formatMoney,
  SCOPE_SNAPSHOT_FOOTER,
  SCOPE_SNAPSHOT_LABELS,
  SCOPE_SNAPSHOT_TITLE,
  scopeSnapshotLabel,
  type Locale,
  type ScopeSnapshotDocument,
  type ScopeSnapshotLabel,
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
  // M4-03: Hindi workspaces get "English · हिन्दी" labels; values stay as recorded (PayPal-bound evidence)
  const l = (key: ScopeSnapshotLabel): string => scopeSnapshotLabel(key, d.locale);
  // English grouping for PayPal's reviewer, from the decimal string (core formatMoney, never a float)
  const amount = `${formatMoney(d.payment.amount, d.payment.currency, "en-US")} ${d.payment.currency}`;
  flow.text(l("title"), H1);
  flow.text(`${l("generator")} ${d.generatedAt}`, SMALL);
  flow.gap(10);
  flow.text(l("payment"), H2);
  flow.text(`${l("captureId")}: ${d.payment.captureId}`, BODY);
  flow.text(`${l("amount")}: ${amount}`, BODY);
  flow.text(`${l("date")}: ${d.payment.date}`, BODY);
  flow.gap(10);
  flow.text(l("scope"), H2);
  flow.text(`${l("scopeSha")}: ${d.scope.sha256}`, SMALL);
  flow.gap(4);
  flow.text(d.scope.text ?? l("scopeFile"), BODY);
  flow.gap(10);
  flow.text(l("delivery"), H2);
  if (d.delivery.length === 0) flow.text(l("noDelivery"), BODY);
  for (const item of d.delivery)
    flow.text(`${item.kind} · ${l("added")} ${item.createdAt} · sha256 ${item.sha256}`, SMALL);
  flow.gap(10);
  flow.text(l("ack"), H2);
  if (d.ack === null) flow.text(l("notAcknowledged"), BODY);
  else {
    flow.text(`${l("typedName")}: ${d.ack.typedName}`, BODY);
    flow.text(`${l("acceptedAt")}: ${d.ack.acceptedAt} (UTC)`, BODY);
    flow.text(`${l("sellerTime")}: ${localTime(d.ack.acceptedAt, d.timeZone)}`, BODY);
    flow.text(`${l("ip")}: ${d.ack.ip}`, BODY);
    flow.text(`${l("userAgent")}: ${d.ack.userAgent}`, SMALL);
    flow.text(`${l("ackSha")}: ${d.ack.sha256}`, SMALL);
  }
  flow.gap(10);
  flow.text(`${l("generatedAt")}: ${d.generatedAt}`, BODY);
  if (d.locale === "hi") {
    flow.gap(6);
    flow.text(SCOPE_SNAPSHOT_LABELS.footer[1], SMALL);
  }
}

function footers(doc: PDFDocument, gt: GlyphText, locale: Locale): void {
  const lines = wrapText(SCOPE_SNAPSHOT_FOOTER, gt.font, FOOTER_SIZE, WIDTH);
  const pages = doc.getPages();
  const [, pageHi] = SCOPE_SNAPSHOT_LABELS.page;
  pages.forEach((page, i) => {
    const [n, of] = [String(i + 1), String(pages.length)];
    const number = `Page ${n} of ${of}${locale === "hi" ? ` · ${pageHi} ${n} / ${of}` : ""}`;
    let y = MARGIN + 11 * lines.length;
    for (const line of [...lines, number]) {
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
  footers(doc, gt, d.locale);
  const at = new Date(d.generatedAt);
  doc.setTitle(`${SCOPE_SNAPSHOT_TITLE} · PayPal capture ${d.payment.captureId}`);
  doc.setSubject(`Cleared scope snapshot of proof pack ${d.packId}`);
  doc.setProducer("Cleared");
  doc.setCreator("Cleared");
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const bytes = await doc.save({ useObjectStreams: true });
  if (bytes.byteLength >= EVIDENCE_LIMITS.maxFileBytes)
    throw new Error(
      `scope snapshot is ${String(bytes.byteLength)} bytes (limit < ${String(EVIDENCE_LIMITS.maxFileBytes)})`,
    );
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
