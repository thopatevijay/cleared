// M2-01: intake rules (caps, accepted types, normalisation, the sha256 input, pack state after evidence).
import { describe, expect, it } from "vitest";
import { PACK_STATES } from "./pack.ts";
import {
  checkEvidenceCapacity,
  checkEvidenceSize,
  checkEvidenceText,
  checkEvidenceType,
  checkImagePixels,
  checkPdf,
  EVIDENCE_ERROR_CODES,
  EVIDENCE_ITEMS_PER_PACK,
  EVIDENCE_KINDS,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TEXT_MAX_CHARS,
  EVIDENCE_WORKSPACE_MAX_BYTES,
  evidenceHashInput,
  evidenceWireCode,
  normaliseEvidenceText,
  packStateAfterEvidence,
  SELLER_EVIDENCE_KINDS,
  SellerEvidenceKindSchema,
} from "./evidence.ts";

const code = (r: { ok: boolean; error?: { code: string } }): string | null =>
  r.ok ? null : (r.error?.code ?? "?");

describe("evidence caps", () => {
  it("size: under 10 MB (decimal) passes; 10 MB and 10 MB + 1 byte are EVIDENCE_TOO_LARGE", () => {
    expect(EVIDENCE_MAX_BYTES).toBe(10_000_000);
    expect(code(checkEvidenceSize(9_999_999))).toBeNull();
    expect(code(checkEvidenceSize(10_000_000))).toBe("EVIDENCE_TOO_LARGE");
    expect(code(checkEvidenceSize(10_000_001))).toBe("EVIDENCE_TOO_LARGE");
    expect(code(checkEvidenceSize(10 * 1024 * 1024 + 1))).toBe("EVIDENCE_TOO_LARGE");
  });

  it("type: only the sniffed jpg/png/gif/pdf pass, everything else is EVIDENCE_TYPE", () => {
    for (const m of ["image/jpeg", "image/png", "image/gif", "application/pdf"]) {
      const r = checkEvidenceType(m);
      expect(r).toEqual({ ok: true, value: m });
    }
    for (const m of [null, "text/html", "image/webp", "image/svg+xml", "application/zip", ""]) {
      expect(code(checkEvidenceType(m))).toBe("EVIDENCE_TYPE");
    }
  });

  it("pixels: 25 MP passes, 26 MP is EVIDENCE_TOO_MANY_PIXELS, zero or NaN is unreadable", () => {
    expect(code(checkImagePixels(5000, 5000))).toBeNull();
    expect(code(checkImagePixels(5200, 5000))).toBe("EVIDENCE_TOO_MANY_PIXELS");
    expect(code(checkImagePixels(0, 10))).toBe("EVIDENCE_UNREADABLE");
    expect(code(checkImagePixels(Number.NaN, 10))).toBe("EVIDENCE_UNREADABLE");
  });

  it("pdf: encrypted first, then > 30 pages, then no pages", () => {
    expect(code(checkPdf({ encrypted: false, pages: 30 }))).toBeNull();
    expect(code(checkPdf({ encrypted: false, pages: 31 }))).toBe("EVIDENCE_TOO_MANY_PAGES");
    expect(code(checkPdf({ encrypted: true, pages: 31 }))).toBe("EVIDENCE_ENCRYPTED");
    expect(code(checkPdf({ encrypted: false, pages: 0 }))).toBe("EVIDENCE_UNREADABLE");
  });

  it("capacity: 50 items per pack and 200 MB per workspace", () => {
    const base = { itemsInPack: 0, workspaceBytes: 0, addBytes: 1 };
    expect(code(checkEvidenceCapacity(base))).toBeNull();
    expect(code(checkEvidenceCapacity({ ...base, itemsInPack: EVIDENCE_ITEMS_PER_PACK - 1 }))).toBeNull();
    expect(code(checkEvidenceCapacity({ ...base, itemsInPack: EVIDENCE_ITEMS_PER_PACK }))).toBe(
      "EVIDENCE_PACK_FULL",
    );
    const full = { itemsInPack: 0, workspaceBytes: EVIDENCE_WORKSPACE_MAX_BYTES - 10, addBytes: 10 };
    expect(code(checkEvidenceCapacity(full))).toBeNull();
    expect(code(checkEvidenceCapacity({ ...full, addBytes: 11 }))).toBe("EVIDENCE_WORKSPACE_FULL");
  });

  it("wire codes are the ADR 0003 snake_case form of the typed codes", () => {
    expect(EVIDENCE_ERROR_CODES.map(evidenceWireCode)).toContain("evidence_too_many_pixels");
    for (const c of EVIDENCE_ERROR_CODES) expect(evidenceWireCode(c)).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("evidence text and the sha256 rule", () => {
  it("normalises CRLF to LF and to NFC", () => {
    expect(normaliseEvidenceText("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normaliseEvidenceText("café")).toBe("café");
  });

  it("the hash input of pasted text is identical across CRLF/LF and NFD/NFC variants", () => {
    const lf = evidenceHashInput({ kind: "text", text: "Client: ok\nSeller: sent\n" });
    const crlf = evidenceHashInput({ kind: "text", text: "Client: ok\r\nSeller: sent\r\n" });
    expect(Buffer.from(crlf).equals(Buffer.from(lf))).toBe(true);
    const nfd = evidenceHashInput({ kind: "text", text: "René" });
    const nfc = evidenceHashInput({ kind: "text", text: "René" });
    expect(Buffer.from(nfd).equals(Buffer.from(nfc))).toBe(true);
  });

  it("a file hashes its stored bytes as they are", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(evidenceHashInput({ kind: "file", bytes })).toBe(bytes);
  });

  it("checks pasted text: empty, too long, NUL; returns the normalised text", () => {
    expect(checkEvidenceText("x\r\ny")).toEqual({ ok: true, value: "x\ny" });
    expect(code(checkEvidenceText(" \r\n\t"))).toBe("EVIDENCE_TEXT_EMPTY");
    expect(code(checkEvidenceText("a".repeat(EVIDENCE_TEXT_MAX_CHARS)))).toBeNull();
    expect(code(checkEvidenceText("a".repeat(EVIDENCE_TEXT_MAX_CHARS + 1)))).toBe("EVIDENCE_TEXT_TOO_LONG");
    // 50,000 characters after CRLF → LF: a pasted Windows chat is measured as stored
    expect(code(checkEvidenceText("a\r\n".repeat(25_000)))).toBeNull();
    expect(code(checkEvidenceText("a\u0000b"))).toBe("EVIDENCE_UNREADABLE");
  });
});

describe("kinds and pack state", () => {
  it("seller kinds are the enum minus the system-produced scope_snapshot and client_ack", () => {
    expect(SELLER_EVIDENCE_KINDS.every((k) => (EVIDENCE_KINDS as readonly string[]).includes(k))).toBe(true);
    expect(SellerEvidenceKindSchema.safeParse("client_ack").success).toBe(false);
    expect(SellerEvidenceKindSchema.safeParse("scope_snapshot").success).toBe(false);
    expect(SellerEvidenceKindSchema.safeParse("delivery").success).toBe(true);
  });

  it("new evidence: empty → collecting, checked/ready → stale, collecting and stale stay", () => {
    const after = Object.fromEntries(PACK_STATES.map((s) => [s, packStateAfterEvidence(s)]));
    expect(after).toEqual({
      empty: "collecting",
      collecting: "collecting",
      checked: "stale",
      ready: "stale",
      stale: "stale",
    });
  });
});
