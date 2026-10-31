// M2-01: one uploaded file → stored bytes, or a typed refusal. Covers every rejection the AC names.
import { describe, expect, it } from "vitest";
import { evidenceSha256, sha256Of } from "./hash.ts";
import { containsAscii, fixtureFile, sampleEvidence } from "./files.fixtures.ts";
import { prepareEvidenceFile } from "./prepare.ts";

const codeOf = async (bytes: Uint8Array): Promise<string | null> => {
  const r = await prepareEvidenceFile(bytes);
  return r.ok ? null : r.error.code;
};

describe("prepareEvidenceFile: refusals", () => {
  it("a .png-named HTML file → EVIDENCE_TYPE", async () => {
    expect(await codeOf(fixtureFile("html-named.png"))).toBe("EVIDENCE_TYPE");
  });

  it("10 MB + 1 byte → EVIDENCE_TOO_LARGE, before the type is even read", async () => {
    const big = new Uint8Array(10_000_001);
    big.set(fixtureFile("screenshot-exif.png"));
    expect(await codeOf(big)).toBe("EVIDENCE_TOO_LARGE");
    expect(await codeOf(new Uint8Array(10 * 1024 * 1024 + 1))).toBe("EVIDENCE_TOO_LARGE");
  });

  it("a 31-page PDF → EVIDENCE_TOO_MANY_PAGES; 30 pages pass", async () => {
    expect(await codeOf(fixtureFile("pages-31.pdf"))).toBe("EVIDENCE_TOO_MANY_PAGES");
    expect(await codeOf(fixtureFile("pages-30.pdf"))).toBeNull();
  });

  it("an encrypted PDF → EVIDENCE_ENCRYPTED", async () => {
    expect(await codeOf(fixtureFile("encrypted.pdf"))).toBe("EVIDENCE_ENCRYPTED");
  });

  it("a 26 MP image → EVIDENCE_TOO_MANY_PIXELS (header only: a truncated copy is refused the same way)", async () => {
    expect(await codeOf(fixtureFile("huge-26mp.png"))).toBe("EVIDENCE_TOO_MANY_PIXELS");
    expect(await codeOf(fixtureFile("huge-26mp.png").slice(0, 64))).toBe("EVIDENCE_TOO_MANY_PIXELS");
  });

  it("corrupt data of an accepted type → EVIDENCE_UNREADABLE, never a throw", async () => {
    expect(await codeOf(fixtureFile("screenshot-exif.png").slice(0, 60))).toBe("EVIDENCE_UNREADABLE");
    expect(await codeOf(new TextEncoder().encode("%PDF-1.7\n%garbage"))).toBe("EVIDENCE_UNREADABLE");
    expect(await codeOf(fixtureFile("screenshot-exif.png").slice(0, 20))).toBe("EVIDENCE_UNREADABLE");
  });
});

describe("prepareEvidenceFile: accepted files", () => {
  it.each([
    ["photo-exif.jpg", "image/jpeg"],
    ["screenshot-exif.png", "image/png"],
    ["animation.gif", "image/gif"],
  ] as const)("%s is re-encoded (%s), hashed over the stored bytes, text null", async (name, mime) => {
    const input = fixtureFile(name);
    const r = await prepareEvidenceFile(input);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.mime).toBe(mime);
    expect(r.value.text).toBeNull();
    expect(r.value.size).toBe(r.value.bytes.byteLength);
    expect(r.value.uploadedSize).toBe(input.byteLength);
    expect(r.value.sha256).toBe(sha256Of(r.value.bytes));
    expect(containsAscii(r.value.bytes, "Synthetic Seller")).toBe(false);
  });

  it("a text-layer PDF (M0 sample delivery-note.pdf) keeps its text", async () => {
    const r = await prepareEvidenceFile(sampleEvidence("delivery-note.pdf"));
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.mime).toBe("application/pdf");
    expect(r.value.text).toContain("Delivery note (synthetic sample, Cleared sandbox test data)");
  });

  it("the same upload twice gives the same sha256", async () => {
    const a = await prepareEvidenceFile(sampleEvidence("screenshot-logo.png"));
    const b = await prepareEvidenceFile(sampleEvidence("screenshot-logo.png"));
    expect(a.ok && b.ok && a.value.sha256 === b.value.sha256).toBe(true);
  });
});

describe("evidenceSha256", () => {
  it("text: stable across CRLF/LF; file: the bytes as given", () => {
    const lf = evidenceSha256({ kind: "text", text: "Buyer: received\nSeller: thanks\n" });
    const crlf = evidenceSha256({ kind: "text", text: "Buyer: received\r\nSeller: thanks\r\n" });
    expect(crlf).toBe(lf);
    const bytes = new TextEncoder().encode("abc");
    expect(evidenceSha256({ kind: "file", bytes })).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
