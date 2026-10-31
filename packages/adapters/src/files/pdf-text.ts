// PDF text layer (M2-01): deterministic extraction with pdf.js (via unpdf), no model. The text is what
// M2-04 checks quotes against, so it is normalised exactly like pasted text (NFC, CRLF → LF).
import { normaliseEvidenceText } from "@cleared/core";
import { extractText, getDocumentProxy } from "unpdf";

/** The PDF's text, pages joined by "\n"; `null` when it has no text layer (a scanned PDF). */
export async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  // pdf.js transfers (detaches) the buffer it is given, so it gets its own copy. No eval, no fonts
  // loaded into the process: only the text layer is read.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    stopAtErrors: true,
    disableFontFace: true,
  });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const joined = normaliseEvidenceText(text.join("\n")).replaceAll("\u0000", "");
    return joined.trim() === "" ? null : joined;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
