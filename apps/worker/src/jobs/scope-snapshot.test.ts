// M3-07 AC 1–5 on the fixture packs: the rendered PDF is deterministic, parses, stays under PayPal's 10 MB,
// carries the scope verbatim (Devanagari included), says "signature" only in its negating footer, and shows
// the acknowledgement block or "Not acknowledged by the client". M4-03: bilingual labels for a Hindi
// workspace, and text snapshots of every fixture.
import { extractPdfText, readPdfInfo, missingGlyphs, renderScopeSnapshotPdf } from "@cleared/adapters/files";
import {
  EVIDENCE_FILE_MAX_BYTES,
  SCOPE_SNAPSHOT_FOOTER,
  SCOPE_SNAPSHOT_LABELS,
  SCOPE_SNAPSHOT_NOT_ACKNOWLEDGED,
} from "@cleared/core";
import { describe, expect, it } from "vitest";
import {
  flat,
  SNAPSHOT_FIXTURES,
  snapshotFixture,
  type SnapshotFixture,
} from "../../test/snapshot-support.ts";

async function rendered(name: SnapshotFixture) {
  const doc = snapshotFixture(name);
  const pdf = await renderScopeSnapshotPdf(doc);
  return { doc, pdf, text: (await extractPdfText(pdf.bytes)) ?? "" };
}

describe("scope snapshot PDF (M3-07)", () => {
  it("AC1: rendering the same fixture pack twice gives an identical sha256", async () => {
    for (const name of SNAPSHOT_FIXTURES) {
      const [a, b] = [await rendered(name), await rendered(name)];
      expect(a.pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.pdf.sha256).toBe(a.pdf.sha256);
      expect(Buffer.from(b.pdf.bytes).equals(Buffer.from(a.pdf.bytes))).toBe(true);
    }
  });

  it("AC2: the PDF loads with pdf-lib, is under 10 MB, and has the scope verbatim and the footer", async () => {
    for (const name of SNAPSHOT_FIXTURES) {
      const { doc, pdf, text } = await rendered(name);
      const loaded = await readPdfInfo(pdf.bytes); // pdf-lib load
      expect(loaded.pageCount).toBe(pdf.pageCount);
      expect(loaded.producer).toBe("Cleared");
      expect(loaded.creationDate?.toISOString()).toBe(doc.generatedAt);
      expect(pdf.size).toBeLessThan(EVIDENCE_FILE_MAX_BYTES);
      expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
      expect(flat(text)).toContain(flat(doc.scope.text ?? ""));
      expect(text).toContain("This is not a signature or a contract");
      expect(flat(text)).toContain(SCOPE_SNAPSHOT_FOOTER);
      expect(text).toContain("Scope snapshot");
      for (const s of [
        doc.payment.captureId,
        "240.00 USD",
        doc.payment.date,
        doc.scope.sha256,
        doc.generatedAt,
      ])
        expect(text).toContain(s);
      for (const d of doc.delivery) expect(text).toContain(d.sha256);
    }
  });

  it("AC3: 'signed' and 'signature' appear only in the negating footer", async () => {
    for (const name of SNAPSHOT_FIXTURES) {
      const { text } = await rendered(name);
      const words = /\bsign(ed|ature)\b/gi;
      expect(flat(text).match(words)).toEqual(["signature"]); // once per page; every fixture is one page
      expect(flat(flat(text).replace(SCOPE_SNAPSHOT_FOOTER, ""))).not.toMatch(words);
    }
  });

  it("AC4: with a client_ack the block shows accepted_at (UTC + seller time) and the ack sha256", async () => {
    const { doc, text } = await rendered("en-ack");
    if (doc.ack === null) throw new Error("fixture has an ack");
    expect(text).toContain(`Accepted at: ${doc.ack.acceptedAt} (UTC)`);
    expect(text).toContain("Seller's local time: 2026-10-05 15:00:12 (Asia/Kolkata)");
    expect(text).toContain(`Acknowledgement record sha256: ${doc.ack.sha256}`);
    expect(text).toContain(`Typed name: ${doc.ack.typedName}`);
    expect(text).toContain(`IP address: ${doc.ack.ip}`);
    expect(text).not.toContain(SCOPE_SNAPSHOT_NOT_ACKNOWLEDGED);
  });

  it("AC4: without a client_ack it shows 'Not acknowledged by the client'", async () => {
    const { text } = await rendered("en-no-ack");
    expect(text).toContain(SCOPE_SNAPSHOT_NOT_ACKNOWLEDGED);
    expect(text).not.toContain("Accepted at:");
  });

  it("AC5: Devanagari scope text renders with no missing glyphs and extracts back verbatim", async () => {
    const { doc, text } = await rendered("hi");
    const scope = doc.scope.text ?? "";
    expect(scope).toMatch(/[ऀ-ॿ]/);
    expect(await missingGlyphs(scope)).toEqual([]);
    expect(await missingGlyphs(doc.ack?.typedName ?? "")).toEqual([]);
    for (const line of scope.split("\n").filter((l) => l !== "")) expect(text).toContain(line); // line by line, exact
    expect(text).toContain("Typed name · टाइप किया गया नाम: आशा राव");
  });

  // M4-03 AC 6: the extracted text of each fixture, so a label or format change is reviewed. A Hindi
  // workspace's labels are bilingual with English first; an English workspace's are English only.
  for (const name of SNAPSHOT_FIXTURES) {
    it(`M4-03: text snapshot, ${name}`, async () => {
      const { doc, text } = await rendered(name);
      expect(doc.locale).toBe(name === "hi" ? "hi" : "en");
      expect(text).toMatchSnapshot();
    });
  }

  it("M4-03: Hindi labels keep the English beside them, and every label glyph is in the font", async () => {
    const { text } = await rendered("hi");
    // the hi fixture has a scope text, delivery items and an acknowledgement: every other label prints
    const conditional = new Set(["scopeFile", "noDelivery", "notAcknowledged", "footer", "page"]);
    for (const [key, [en, hi]] of Object.entries(SCOPE_SNAPSHOT_LABELS)) {
      if (!conditional.has(key)) expect(flat(text)).toContain(`${en} · ${hi}`);
    }
    expect(text).toContain("Page 1 of 1 · पृष्ठ 1 / 1");
    expect(flat(text)).toContain(SCOPE_SNAPSHOT_LABELS.footer[1]);
    expect(await missingGlyphs(Object.values(SCOPE_SNAPSHOT_LABELS).flat().join(" "))).toEqual([]);
    const en = await rendered("en-ack");
    expect(en.text).not.toMatch(/[ऀ-ॿ]/);
  });

  it("a glyph the font lacks is reported (it would print as a box)", async () => {
    expect(await missingGlyphs("logo 🎨 中")).toEqual(["🎨", "中"]);
  });
});
