// M3-07 gate artifact: renders the acknowledged fixture pack to `os.tmpdir()/m3-07.pdf` (honours $TMPDIR) so
// the gate can `ls` and `shasum` it, and so a person can open the real file.
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPdfInfo, renderScopeSnapshotPdf } from "@cleared/adapters/files";
import { EVIDENCE_FILE_MAX_BYTES } from "@cleared/core";
import { describe, expect, it } from "vitest";
import { snapshotFixture } from "../../test/snapshot-support.ts";

describe("scope snapshot artifact (M3-07)", () => {
  it("writes the en-ack fixture pack's snapshot to the temp dir as m3-07.pdf", async () => {
    const pdf = await renderScopeSnapshotPdf(snapshotFixture("en-ack"));
    const path = join(tmpdir(), "m3-07.pdf");
    await writeFile(path, pdf.bytes);
    expect((await readPdfInfo(pdf.bytes)).pageCount).toBeGreaterThan(0);
    expect(pdf.size).toBeLessThan(EVIDENCE_FILE_MAX_BYTES);
    console.info(`m3-07.pdf: ${path} · ${String(pdf.size)} bytes · sha256 ${pdf.sha256}`);
  });
});
