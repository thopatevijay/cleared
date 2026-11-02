// Text that both looks right and extracts right (M3-07, ADR 0018). pdf-lib shapes custom-font text with
// fontkit, so Devanagari is drawn correctly, but the content stream then holds glyphs in visual order (a
// pre-base matra before its consonant) and text extraction no longer gives back what was typed. Each line is
// therefore written twice, the way OCR'd PDFs are:
// - visible: the shaped glyph outlines (one form XObject per glyph, filled), with GPOS offsets applied
// - invisible (text render mode 3): the line in logical order, one glyph per code point, through the
//   embedded font's ToUnicode map, so selection, search and extraction return the typed text exactly
// The font is embedded whole (not subset) so its glyph ids and ToUnicode cover every code point it has.
import fontkit from "@cantoo/fontkit";
import {
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endText,
  fill,
  lineTo,
  moveText,
  moveTo,
  PDFHexString,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setFontAndSize,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  type Color,
  type PDFDocument,
  type PDFFont,
  type PDFName,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
} from "@cantoo/pdf-lib";

interface FkGlyph {
  readonly id: number;
  readonly path: { readonly commands: readonly { command: string; args: number[] }[] };
  readonly bbox: { minX: number; minY: number; maxX: number; maxY: number };
}
interface FkFont {
  readonly unitsPerEm: number;
  glyphForCodePoint(cp: number): FkGlyph | null;
  layout(text: string): {
    glyphs: FkGlyph[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[] | null;
  };
}

export interface GlyphText {
  /** the embedded font (whole), also what `wrapText` measures with */
  readonly font: PDFFont;
  readonly draw: (
    page: PDFPage,
    line: string,
    at: { x: number; y: number; size: number; color: Color },
  ) => void;
}

/** Glyph outline in font units (y up) as PDF path operators; quadratic curves become cubic. */
function outline(glyph: FkGlyph): PDFOperator[] {
  const ops: PDFOperator[] = [];
  let [cx, cy] = [0, 0];
  for (const { command, args } of glyph.path.commands) {
    const a = args;
    if (command === "moveTo") ops.push(moveTo(a[0] ?? 0, a[1] ?? 0));
    else if (command === "lineTo") ops.push(lineTo(a[0] ?? 0, a[1] ?? 0));
    else if (command === "bezierCurveTo")
      ops.push(appendBezierCurve(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0));
    else if (command === "quadraticCurveTo") {
      const [qx, qy, x, y] = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0];
      const k = 2 / 3;
      ops.push(
        appendBezierCurve(cx + k * (qx - cx), cy + k * (qy - cy), x + k * (qx - x), y + k * (qy - y), x, y),
      );
    } else if (command === "closePath") ops.push(closePath());
    if (a.length >= 2) [cx, cy] = [a[a.length - 2] ?? 0, a[a.length - 1] ?? 0];
  }
  if (ops.length > 0) ops.push(fill());
  return ops;
}

/** 4-hex-digit glyph ids of `line` in logical order (Identity-H: CID = glyph id when not subset). */
function logicalHex(fk: FkFont, line: string): string {
  return Array.from(line)
    .map((ch) => (fk.glyphForCodePoint(ch.codePointAt(0) ?? 0)?.id ?? 0).toString(16).padStart(4, "0"))
    .join("");
}

export async function glyphText(doc: PDFDocument, fontBytes: Uint8Array): Promise<GlyphText> {
  const font = await doc.embedFont(fontBytes, { subset: false });
  const fk = fontkit.create(Buffer.from(fontBytes)) as unknown as FkFont;
  const forms = new Map<number, PDFRef | null>();
  const formFor = (g: FkGlyph): PDFRef | null => {
    if (!forms.has(g.id)) {
      const ops = outline(g);
      const { minX, minY, maxX, maxY } = g.bbox;
      const bbox = [minX, minY, maxX, maxY].map((n) => (Number.isFinite(n) ? n : 0));
      forms.set(
        g.id,
        ops.length === 0 ? null : doc.context.register(doc.context.formXObject(ops, { BBox: bbox })),
      );
    }
    return forms.get(g.id) ?? null;
  };
  const names = new WeakMap<PDFPage, { font: PDFName; glyphs: Map<number, PDFName> }>();
  const keysOf = (page: PDFPage) => {
    let k = names.get(page);
    if (k === undefined) {
      k = { font: page.node.newFontDictionary("F", font.ref), glyphs: new Map() };
      names.set(page, k);
    }
    return k;
  };
  return {
    font,
    draw(page, line, { x, y, size, color }) {
      const keys = keysOf(page);
      const scale = size / fk.unitsPerEm;
      const run = fk.layout(line);
      const ops: PDFOperator[] = [pushGraphicsState(), setFillingColor(color)];
      let pen = 0;
      run.glyphs.forEach((g, i) => {
        const pos = run.positions?.[i] ?? { xAdvance: 0, xOffset: 0, yOffset: 0 };
        const ref = formFor(g);
        if (ref !== null) {
          let name = keys.glyphs.get(g.id);
          if (name === undefined) {
            name = page.node.newXObject("G", ref);
            keys.glyphs.set(g.id, name);
          }
          const [tx, ty] = [x + (pen + pos.xOffset) * scale, y + pos.yOffset * scale];
          ops.push(
            pushGraphicsState(),
            concatTransformationMatrix(scale, 0, 0, scale, tx, ty),
            drawObject(name),
            popGraphicsState(),
          );
        }
        pen += pos.xAdvance;
      });
      ops.push(popGraphicsState());
      ops.push(
        pushGraphicsState(),
        beginText(),
        setFontAndSize(keys.font, size),
        setTextRenderingMode(TextRenderingMode.Invisible),
        moveText(x, y),
        showText(PDFHexString.of(logicalHex(fk, line))),
        endText(),
        popGraphicsState(),
      );
      page.pushOperators(...ops);
    },
  };
}
